// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #806 — the admin side of remote MCP: `/api/mcp/remote/chat` and
 * `/api/mcp/remote/admin`, MCP Streamable HTTP endpoints for clients that
 * reach the admin through Google IAP with the user's own Google identity
 * (via the gateway's OAuth broker; no bearer token, no local shim).
 *
 * Identity is IAP's signed assertion — verified, mapped to a Caelo user and
 * that user's `mcp_remote_connections` row for the client app the gateway
 * names (`x-caelo-mcp-client`, #968; mcp_principal.ts) BEFORE any
 * MCP processing, so auth failures are plain HTTP 401/403/503 with a
 * structured body. The MCP servers are the very ones the stdio shims run
 * (`@caelo-cms/mcp-server/surfaces`), backed here by the `mcp.*` ops
 * in-process instead of HTTP; every op call carries the request's IAP
 * assertion and re-verifies it, so no op ever trusts a caller-supplied id.
 *
 * Stateless transport: Cloud Run scales horizontally and a follow-up
 * request may land on any instance, so each request gets its own server +
 * transport and nothing lives in memory between requests (the Power-MCP
 * work session lives on the connection row). A GET (the optional
 * server-to-client SSE stream) is answered 405, which the spec allows;
 * replies to a POST still stream as SSE, progress notifications included.
 *
 * Re-verifying the assertion per op call means a request outliving the
 * assertion (IAP signs them for minutes, not hours) fails its LATER op calls
 * with `auth_error:` — e.g. the approval poll after a very long caelo_chat
 * turn. The tool result then names the next step (caelo_await_approval),
 * which arrives as a new request with a fresh assertion. That is the price
 * of never trusting an id across the op boundary, and deliberately so.
 */

import {
  IAP_ASSERTION_HEADER,
  MCP_CLIENT_HEADER,
  type McpPrincipal,
  type McpRemoteCredential,
  type McpRemoteSurface,
  mcpClientKey,
  type RemoteMcpRefusal,
  resolveRemoteMcpPrincipal,
} from "@caelo-cms/admin-core";
import {
  type AdminSurfaceBackend,
  type ApprovalOutcome,
  type ChatApprovalState,
  type ChatSurfaceBackend,
  createAdminMcpServer,
  createChatMcpServer,
  DEFAULT_APPROVAL_WAIT_MS,
  type ExecuteToolResponse,
  type GetContextResponse,
  type OpenSessionResponse,
  REMOTE_UPLOAD_IMAGES_TOOL,
  type RemoteTool,
  type SendChatResult,
  uploadImagesWith,
} from "@caelo-cms/mcp-server/surfaces";
import { execute } from "@caelo-cms/query-api";
import { CAELO_VERSION } from "@caelo-cms/shared";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isHttpError } from "@sveltejs/kit";
import { mcpSystemCtx } from "./mcp-http.js";
import { uploadMedia } from "./media-upload.js";
import { getQueryContext } from "./query.js";

/**
 * Budget a resumed caelo_chat turn is given inside one call: in-process
 * there is no HTTP timeout, so this mirrors the stdio shim's resume timeout
 * to keep the two surfaces' wait behaviour identical.
 */
const RESUME_RESERVE_MS = 30_000;

const FILE_PATH_REFUSAL =
  "filePath is not available over a remote MCP connection — the server runs in the Caelo admin and cannot read files on your machine. Send the image bytes as base64 instead.";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The structured HTTP answer for a refused remote request. */
export function remoteRefusalResponse(refusal: RemoteMcpRefusal): Response {
  return jsonResponse(refusal.status, { error: refusal.code, message: refusal.message });
}

/**
 * The client app the gateway named (#968), or null when the request did not
 * come through the gateway (or the value is not a client key); the
 * resolver refuses the empty key with `missing_client_identity`.
 */
function clientKeyOf(request: Request): string | null {
  const raw = request.headers.get(MCP_CLIENT_HEADER);
  if (raw === null) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const parsed = mcpClientKey.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/** The MCP client's self-reported name, when the body is an initialize request. */
function clientLabelOf(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const msg = m as { method?: unknown; params?: { clientInfo?: { name?: unknown } } };
    const name = msg.params?.clientInfo?.name;
    if (msg.method === "initialize" && typeof name === "string" && name.trim()) {
      return name.trim().slice(0, 200);
    }
  }
  return undefined;
}

/** Run one `mcp.*` op with the remote credential; failures become thrown messages. */
async function runOp<T>(
  op: string,
  credential: McpRemoteCredential,
  input: Record<string, unknown>,
): Promise<T> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, mcpSystemCtx(`mcp-remote:${op}`), op, {
    remote: credential,
    ...input,
  });
  if (!r.ok) {
    throw new Error("message" in r.error ? String(r.error.message) : r.error.kind);
  }
  return r.value as T;
}

/** caelo_upload_images over a remote connection: base64 in, stored in-process. */
function uploadImagesFor(credential: McpRemoteCredential) {
  return (args: unknown) => {
    // Authorised once per call, before any bytes are stored: the op checks
    // the user's CURRENT content.write, like the stdio path's /api/mcp/images.
    let authorised: Promise<{ actorId: string }> | null = null;
    return uploadImagesWith(args, {
      filePathRefusal: FILE_PATH_REFUSAL,
      store: async (bytes, meta) => {
        authorised ??= runOp<{ actorId: string }>("mcp.authorize_upload", credential, {});
        const { actorId } = await authorised;
        const requestId = crypto.randomUUID();
        try {
          const stored = (await uploadMedia(
            new Request("http://caelo.internal/mcp-remote-upload", {
              method: "POST",
              body: new Uint8Array(bytes),
              headers: { "content-length": String(bytes.byteLength) },
            }),
            { actorId, actorKind: "human", requestId },
            true,
            {
              filename: meta.filename,
              ...(meta.alt ? { alt: meta.alt } : {}),
              ...(meta.reference ? { visibility: "reference" as const } : {}),
            },
          )) as { assetId: unknown; mime: unknown };
          return { assetId: stored.assetId, mime: stored.mime };
        } catch (e) {
          if (isHttpError(e)) throw new Error(`HTTP ${e.status}: ${e.body.message}`);
          throw e;
        }
      },
    });
  };
}

function chatBackend(credential: McpRemoteCredential): ChatSurfaceBackend {
  return {
    sendChat: (input) => runOp<SendChatResult>("mcp.send_chat", credential, { ...input }),
    resumeChat: (chatSessionId) =>
      runOp<SendChatResult>("mcp.send_chat", credential, {
        chatSessionId,
        resumeApprovals: true,
      }),
    fetchChatApprovalState: (chatSessionId) =>
      runOp<ChatApprovalState>("mcp.get_chat_approval_state", credential, { chatSessionId }),
    uploadImages: uploadImagesFor(credential),
  };
}

function adminBackend(
  credential: McpRemoteCredential,
  principal: McpPrincipal,
): AdminSurfaceBackend {
  // The connection's current session as of this request; an open_session
  // within the same request (a JSON-RPC batch) takes over from there.
  let currentSessionId =
    principal.via.kind === "remote" ? principal.via.currentChatSessionId : null;
  const catalogue = async () =>
    (await runOp<{ tools: RemoteTool[] }>("mcp.list_tools", credential, {})).tools;
  return {
    listCatalogue: catalogue,
    findTool: async (name) => (await catalogue()).find((t) => t.name === name),
    openSession: async (input) => {
      const session = await runOp<OpenSessionResponse>("mcp.open_session", credential, {
        ...input,
      });
      currentSessionId = session.chatSessionId;
      return session;
    },
    currentSessionId: async () => currentSessionId,
    executeTool: (call) =>
      runOp<ExecuteToolResponse>("mcp.execute_tool", credential, {
        toolName: call.toolName,
        args: call.args,
        chatSessionId: call.chatSessionId,
      }),
    getContext: () =>
      runOp<GetContextResponse>("mcp.get_context", credential, { includeSkillBodies: false }),
    fetchApprovalOutcome: (proposalId) =>
      runOp<ApprovalOutcome>("mcp.get_approval_outcome", credential, { proposalId }),
    uploadImages: uploadImagesFor(credential),
    // #1122 — every list is live; the surface announces the change.
    catalogueMayHaveChanged: async () => true,
  };
}

/**
 * Serve one MCP Streamable HTTP request on `surface`. Authenticates first
 * (HTTP 401/403/503 with `{error, message}` on refusal), then hands the
 * request to a fresh, stateless MCP server.
 */
export async function handleRemoteMcpRequest(
  request: Request,
  surface: McpRemoteSurface,
): Promise<Response> {
  // Parsed up front for the initialize request's client name; a malformed
  // body is answered only AFTER authentication, so an unauthenticated
  // caller learns nothing beyond the auth refusal.
  let parsedBody: unknown;
  let malformedBody = false;
  if (request.method === "POST") {
    try {
      parsedBody = await request.json();
    } catch {
      malformedBody = true;
    }
  }

  // The app is named by the gateway from its sealed access token. Without
  // it there is no connection row to pick, and the resolver refuses
  // (after authenticating, so an unauthenticated caller learns nothing
  // more); a default row would merge every unnamed caller into one.
  const credential: McpRemoteCredential = {
    iapCredential: request.headers.get(IAP_ASSERTION_HEADER) ?? "",
    surface,
    client: clientKeyOf(request) ?? "",
  };
  const { adapter } = getQueryContext();
  const clientLabel = clientLabelOf(parsedBody);
  const resolved = await resolveRemoteMcpPrincipal(
    adapter,
    credential,
    clientLabel ? { clientLabel } : {},
  );
  if (!resolved.ok) return remoteRefusalResponse(resolved.error);

  if (malformedBody) {
    return jsonResponse(400, {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: the request body is not JSON" },
      id: null,
    });
  }

  if (request.method === "GET") {
    // No server-initiated stream on a stateless server (spec: 405 is valid).
    return jsonResponse(
      405,
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed: this server has no SSE stream; POST requests.",
        },
        id: null,
      },
      { allow: "POST, DELETE" },
    );
  }

  const server =
    surface === "chat"
      ? createChatMcpServer(chatBackend(credential), {
          serverVersion: CAELO_VERSION,
          uploadImagesTool: REMOTE_UPLOAD_IMAGES_TOOL,
          approvalWaitMs: () => DEFAULT_APPROVAL_WAIT_MS,
          resumeTimeoutMs: () => RESUME_RESERVE_MS,
        })
      : createAdminMcpServer(adminBackend(credential, resolved.value), {
          serverVersion: CAELO_VERSION,
          uploadImagesTool: REMOTE_UPLOAD_IMAGES_TOOL,
          approvalWaitMs: () => DEFAULT_APPROVAL_WAIT_MS,
          // #1122 — announced on the stream of the call that changed it.
          listChanged: true,
        });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  return transport.handleRequest(request, parsedBody === undefined ? {} : { parsedBody });
}
