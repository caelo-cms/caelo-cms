// SPDX-License-Identifier: MPL-2.0

/**
 * How the broker knows an MCP client (issue #806). All clients are public
 * (no secret; PKCE S256 instead), and the broker stores nothing:
 *
 * - **CIMD** (Client ID Metadata Document): the `client_id` is an https URL
 *   on a host in {@link CIMD_ALLOWED_HOSTS}; the broker fetches it and
 *   takes the `redirect_uris` from it. Only those hosts are ever fetched,
 *   so a client id cannot make the gateway request an internal or
 *   attacker-chosen URL (SSRF). No redirects followed, ≤5 s, ≤64 KB.
 * - **DCR** (RFC 7591 `/register`): the returned `client_id` is a sealed
 *   blob of the registration itself, so "looking up" the client is opening
 *   the seal.
 *
 * Either way, every redirect URI the broker uses must also pass the
 * allowlist (redirect-allowlist.ts): registration is open to anyone, so
 * it is not what keeps codes away from attackers.
 */

import { z } from "zod";
import { readBodyWithCap } from "../middleware/body-cap.js";
import type { McpContext } from "./context.js";
import { json, oauthError } from "./http.js";
import { isAllowedRedirectUri } from "./redirect-allowlist.js";
import { open, seal } from "./seal.js";

/** Hosts whose CIMD documents the broker fetches. Exact hostnames; extend deliberately. */
export const CIMD_ALLOWED_HOSTS: readonly string[] = ["claude.ai", "chatgpt.com"];

/** CIMD fetch limits. */
export const CIMD_TIMEOUT_MS = 5_000;
export const CIMD_MAX_BYTES = 64 * 1024;

/** Largest /register body accepted. */
const REGISTER_MAX_BYTES = 16 * 1024;

/** A client the broker may run the flow for. */
export interface ResolvedClient {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly kind: "cimd" | "dcr";
}

const RedirectUris = z.array(z.string().min(1).max(2048)).min(1).max(20);

/** Payload of a DCR `client_id`. */
export const ClientSealSchema = z.strictObject({
  v: z.literal(1),
  redirect_uris: RedirectUris,
  client_name: z.string().max(200).optional(),
  iat: z.number().int(),
});

const CimdDocumentSchema = z.looseObject({
  client_id: z.string(),
  redirect_uris: RedirectUris,
  client_name: z.string().max(200).optional(),
});

/** Outcome of resolving a `client_id`; `message` names the problem without echoing secrets. */
export type ClientResolution =
  | { readonly ok: true; readonly client: ResolvedClient }
  | { readonly ok: false; readonly message: string };

/** The CIMD URL a client id names, when it is one the broker may fetch. */
export function cimdUrl(clientId: string): URL | null {
  if (!clientId.startsWith("https://")) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return null;
  if (url.search || url.hash || url.href !== clientId) return null;
  if (!CIMD_ALLOWED_HOSTS.includes(url.hostname)) return null;
  return url;
}

async function readCapped(res: Response, cap: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > cap) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveCimd(ctx: McpContext, url: URL): Promise<ClientResolution> {
  const clientId = url.href;
  let res: Response;
  try {
    res = await ctx.fetchImpl(clientId, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: "the client's metadata document could not be fetched" };
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return { ok: false, message: `the client's metadata document answered HTTP ${res.status}` };
  }
  const type = res.headers.get("content-type") ?? "";
  if (!/^application\/([a-z0-9.+-]+\+)?json\b/i.test(type)) {
    await res.body?.cancel();
    return { ok: false, message: "the client's metadata document is not JSON" };
  }
  let text: string | null;
  try {
    text = await readCapped(res, CIMD_MAX_BYTES);
  } catch {
    return { ok: false, message: "the client's metadata document could not be read" };
  }
  if (text === null) return { ok: false, message: "the client's metadata document is too large" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: "the client's metadata document is not JSON" };
  }
  const doc = CimdDocumentSchema.safeParse(raw);
  if (!doc.success) return { ok: false, message: "the client's metadata document is malformed" };
  if (doc.data.client_id !== clientId) {
    return { ok: false, message: "the client's metadata document names a different client_id" };
  }
  // The flow can only ever use a URI that is in the document AND on the
  // allowlist; entries outside the allowlist are unusable, not fatal, so a
  // vendor adding a callback does not lock out its existing ones.
  const usable = doc.data.redirect_uris.filter(isAllowedRedirectUri);
  if (usable.length === 0) {
    return { ok: false, message: "none of the client's redirect URIs is one Caelo accepts" };
  }
  return { ok: true, client: { clientId, redirectUris: usable, kind: "cimd" } };
}

/** Resolve a `client_id` from an authorization request. */
export async function resolveClient(ctx: McpContext, clientId: string): Promise<ClientResolution> {
  if (clientId.startsWith("https://")) {
    const url = cimdUrl(clientId);
    if (!url) {
      return {
        ok: false,
        message: `client metadata documents are only accepted from ${CIMD_ALLOWED_HOSTS.join(", ")}`,
      };
    }
    return resolveCimd(ctx, url);
  }
  const opened = open(ctx.config.sealKey, "client", clientId, ClientSealSchema, ctx.nowSeconds());
  if (!opened.ok) return { ok: false, message: "unknown client_id; register the client again" };
  return {
    ok: true,
    client: { clientId, redirectUris: opened.value.redirect_uris, kind: "dcr" },
  };
}

const RegisterSchema = z.looseObject({
  redirect_uris: RedirectUris,
  token_endpoint_auth_method: z.string().max(64).optional(),
  grant_types: z.array(z.string().max(64)).max(10).optional(),
  response_types: z.array(z.string().max(64)).max(10).optional(),
  client_name: z.string().max(200).optional(),
});

const GRANT_TYPES = ["authorization_code", "refresh_token"];

/** POST /api/mcp/oauth/register — RFC 7591, public clients only, stateless. */
export async function handleRegister(req: Request, ctx: McpContext): Promise<Response> {
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return oauthError("invalid_client_metadata", "send the registration as application/json");
  }
  const body = await readBodyWithCap(req, REGISTER_MAX_BYTES);
  if (!body.ok) return oauthError("invalid_client_metadata", "registration body too large", 413);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body.body));
  } catch {
    return oauthError("invalid_client_metadata", "registration body is not JSON");
  }
  const parsed = RegisterSchema.safeParse(raw);
  if (!parsed.success) {
    return oauthError(
      "invalid_client_metadata",
      "redirect_uris (1–20 strings) is required; client_name, grant_types, response_types must be strings",
    );
  }
  const reg = parsed.data;
  // Absent means the RFC 7591 default (client_secret_basic), which this
  // broker does not offer; the server-chosen value "none" is returned to
  // the client below (RFC 7591 §3.2.1), so nothing is assumed silently.
  if (reg.token_endpoint_auth_method !== undefined && reg.token_endpoint_auth_method !== "none") {
    return oauthError(
      "invalid_client_metadata",
      'only public clients are supported: token_endpoint_auth_method must be "none" (use PKCE S256)',
    );
  }
  if (reg.grant_types?.some((g) => !GRANT_TYPES.includes(g))) {
    return oauthError(
      "invalid_client_metadata",
      "grant_types may only contain authorization_code and refresh_token",
    );
  }
  if (reg.response_types?.some((r) => r !== "code")) {
    return oauthError("invalid_client_metadata", 'response_types may only contain "code"');
  }
  const refused = reg.redirect_uris.filter((u) => !isAllowedRedirectUri(u));
  if (refused.length > 0) {
    return oauthError(
      "invalid_redirect_uri",
      `redirect URI not accepted by this Caelo site: ${refused.map((u) => JSON.stringify(u.slice(0, 200))).join(", ")}. Supported: Claude, ChatGPT, VS Code, Cursor callbacks and http loopback (127.0.0.1, localhost, [::1]).`,
    );
  }
  const iat = ctx.nowSeconds();
  const clientId = seal(ctx.config.sealKey, "client", {
    v: 1,
    redirect_uris: reg.redirect_uris,
    ...(reg.client_name !== undefined ? { client_name: reg.client_name } : {}),
    iat,
  });
  return json(
    {
      client_id: clientId,
      client_id_issued_at: iat,
      redirect_uris: reg.redirect_uris,
      ...(reg.client_name !== undefined ? { client_name: reg.client_name } : {}),
      token_endpoint_auth_method: "none",
      grant_types: GRANT_TYPES,
      response_types: ["code"],
    },
    201,
  );
}
