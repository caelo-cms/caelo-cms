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
 * transport and nothing lives in memory between requests. A GET (the
 * optional server-to-client SSE stream) is answered 405, which the spec
 * allows; replies to a POST still stream as SSE, progress notifications
 * included.
 *
 * Issue #1253 — one work session per agent. The admin mints an MCP
 * transport session id (`Mcp-Session-Id`) on `initialize`; the client sends
 * it back on every request, and caelo_open_session binds the agent's work
 * session to it (`mcp_transport_sessions`, scoped to the connection row, so
 * a made-up header can only name the caller's own mappings). A call's own
 * `workSessionId` wins over it, so sub-agents sharing one connection keep
 * their own sessions. The id also makes the `tools/call` JSON-RPC id an
 * idempotency key: a repeated request returns the first result.
 *
 * Power-MCP (the admin surface) resolves the principal ONCE per request,
 * here, and hands it to the in-process Power-MCP steps — no op re-resolves
 * it, and an approval wait polls with it instead of re-verifying every 3 s
 * (#1253: three resolutions per request, each locking the connection row,
 * queued every agent of one client on that row). A revocation therefore
 * takes effect from the client's next request. The chat surface still
 * runs its `mcp.*` ops with the credential: a request outliving the
 * assertion (IAP signs them for minutes) fails its later op calls with
 * `auth_error:`, and the result names the next step (caelo_await_approval).
 */

import {
  IAP_ASSERTION_HEADER,
  MCP_CLIENT_HEADER,
  type McpPrincipal,
  type McpRemoteCredential,
  type McpRemoteSurface,
  mcpClientKey,
  type PowerResult,
  powerApprovalOutcome,
  powerBridge,
  powerExecuteTool,
  powerGetContext,
  powerListTools,
  powerOpenSession,
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
  NoWorkSessionError,
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

/** A Power-MCP step's value, or its refusal as the thrown message the surface shows. */
function stepValue<T>(r: PowerResult<T>): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

/**
 * The admin surface for one request, on the principal the route resolved
 * (#1253). `transportSessionId` is the request's `Mcp-Session-Id` (null for
 * a client that keeps none).
 */
function adminBackend(
  credential: McpRemoteCredential,
  principal: McpPrincipal,
  transportSessionId: string | null,
): AdminSurfaceBackend {
  const bridge = powerBridge();
  const catalogue = async (): Promise<readonly RemoteTool[]> => powerListTools(principal);
  return {
    listCatalogue: catalogue,
    findTool: async (name) => (await catalogue()).find((t) => t.name === name),
    openSession: async (input) =>
      stepValue<OpenSessionResponse>(
        await powerOpenSession(bridge, principal, {
          ...input,
          ...(transportSessionId ? { transportSessionId } : {}),
        }),
      ),
    executeTool: async ({ rpcRequestId, chatSessionId, ...call }) => {
      if (!chatSessionId && !transportSessionId) throw new NoWorkSessionError();
      return stepValue<ExecuteToolResponse>(
        await powerExecuteTool(bridge, principal, {
          ...call,
          ...(chatSessionId ? { chatSessionId } : {}),
          ...(transportSessionId
            ? {
                transportSessionId,
                toolCallId: `${transportSessionId}:${String(rpcRequestId)}`.slice(0, 128),
              }
            : {}),
        }),
      );
    },
    getContext: async (): Promise<GetContextResponse> => powerGetContext(bridge, principal, false),
    fetchApprovalOutcome: async (proposalId) =>
      stepValue<ApprovalOutcome>(await powerApprovalOutcome(bridge, principal, proposalId)),
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

  const session = transportSessionOf(request, parsedBody);
  const server =
    surface === "chat"
      ? createChatMcpServer(chatBackend(credential), {
          serverVersion: CAELO_VERSION,
          uploadImagesTool: REMOTE_UPLOAD_IMAGES_TOOL,
          approvalWaitMs: () => DEFAULT_APPROVAL_WAIT_MS,
          resumeTimeoutMs: () => RESUME_RESERVE_MS,
        })
      : createAdminMcpServer(adminBackend(credential, resolved.value, session.id), {
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
  const response = await transport.handleRequest(
    request,
    parsedBody === undefined ? {} : { parsedBody },
  );
  if (!session.minted) return response;
  // A stateless transport sends no session id; the admin's own goes out
  // with the initialize answer, and the client echoes it from then on.
  const headers = new Headers(response.headers);
  headers.set(MCP_SESSION_HEADER, session.id);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The MCP transport session header (Streamable HTTP). */
const MCP_SESSION_HEADER = "mcp-session-id";
/** The shape of the ids this admin mints; anything else is not one of ours. */
const TRANSPORT_SESSION_ID = /^[A-Za-z0-9_-]{16,128}$/;

/** Whether the request body is (or a batch holds) an MCP initialize request. */
function isInitialize(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (m) =>
      typeof m === "object" && m !== null && (m as { method?: unknown }).method === "initialize",
  );
}

/**
 * The request's transport session: a fresh id on `initialize` (the client
 * starts a session), else the one the client sent back — or null when it
 * keeps none (it then names its work session on every call).
 */
function transportSessionOf(
  request: Request,
  body: unknown,
): { id: string; minted: true } | { id: string | null; minted: false } {
  if (isInitialize(body)) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return { id: Buffer.from(bytes).toString("base64url"), minted: true };
  }
  const sent = request.headers.get(MCP_SESSION_HEADER);
  return { id: sent !== null && TRANSPORT_SESSION_ID.test(sent) ? sent : null, minted: false };
}
