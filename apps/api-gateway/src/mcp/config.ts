// SPDX-License-Identifier: MPL-2.0

/**
 * Runtime configuration of the remote-MCP broker (issue #806).
 *
 * Two parts with different lifetimes:
 *
 * - **Deploy-time env** (set by provisioning): `CAELO_MCP_PUBLIC_URL`,
 *   `CAELO_ADMIN_URL`, `CAELO_MCP_OAUTH_SEAL_KEY`,
 *   `CAELO_MCP_OAUTH_CLIENT_FILE`, and — only while a seal-key rotation is
 *   in progress — `CAELO_MCP_OAUTH_SEAL_KEY_PREVIOUS`: values sealed under
 *   the previous key (refresh tokens live up to 30 days) still open, new
 *   ones are sealed under the current key. Absent means "no rotation in
 *   progress", not "use something else".
 * - **The Google OAuth client** the Owner creates AFTER deploy. It reaches
 *   the gateway as a Cloud Run secret volume (`CAELO_MCP_OAUTH_CLIENT_FILE`)
 *   whose placeholder content `{}` means "not set up yet", so it is re-read
 *   with a short cache instead of once at boot: saving it must not need a
 *   redeploy.
 *
 * No fallbacks (CLAUDE.md §2): a missing variable, an unreadable file or a
 * half-filled client answers a structured 503 that names what is missing.
 * The broker never invents a default origin, key or client.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { json } from "./http.js";

/** How long a read of the client file is reused (the contract caps it at 60 s). */
export const CLIENT_FILE_CACHE_MS = 60_000;

/** The env variables the broker reads. */
export const MCP_ENV = {
  publicUrl: "CAELO_MCP_PUBLIC_URL",
  adminUrl: "CAELO_ADMIN_URL",
  sealKey: "CAELO_MCP_OAUTH_SEAL_KEY",
  previousSealKey: "CAELO_MCP_OAUTH_SEAL_KEY_PREVIOUS",
  clientFile: "CAELO_MCP_OAUTH_CLIENT_FILE",
} as const;

/** The two MCP surfaces the gateway exposes. */
export const MCP_SURFACES = ["chat", "admin"] as const;
export type McpSurface = (typeof MCP_SURFACES)[number];

/** The Google OAuth client the Owner configured. */
export interface GoogleClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Everything the broker needs, once fully set up. */
export interface McpConfig {
  /** Public origin of the MCP endpoints, no trailing slash. */
  readonly publicUrl: string;
  /** Origin of the IAP-protected admin, no trailing slash. */
  readonly adminUrl: string;
  /** 32-byte AES-256-GCM key every new sealed value is sealed under. */
  readonly sealKey: Uint8Array;
  /** Keys a sealed value may be opened with: `sealKey` first, then the previous key during a rotation. */
  readonly openKeys: readonly Uint8Array[];
  readonly google: GoogleClient;
}

/** Result of loading the configuration. */
export type ConfigResult =
  | { readonly ok: true; readonly config: McpConfig }
  | {
      readonly ok: false;
      /** True only for the placeholder `{}`: the feature is simply not set up. */
      readonly notSetUp: boolean;
      readonly message: string;
    };

/** The message every endpoint answers with while the Owner has not set the feature up. */
export const NOT_SET_UP_MESSAGE =
  "Remote MCP is not set up on this site. An Owner enables it under Settings → MCP.";

/** The structured 503 for an install that cannot serve remote MCP yet. */
export function notConfiguredResponse(message: string): Response {
  return json({ error: "remote_mcp_not_configured", message }, 503);
}

/** Reads the client file (injected in tests). */
export type ReadTextFile = (path: string) => Promise<string>;

const nodeReadFile: ReadTextFile = (path) => readFile(path, "utf8");

const ClientFileSchema = z.union([
  z.strictObject({}),
  z.looseObject({
    client_id: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/, "client_id must be printable ASCII without spaces"),
    client_secret: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/, "client_secret must be printable ASCII without spaces"),
  }),
]);

/**
 * Validate an origin from env: `https://host[:port]`, or `http://` on a
 * loopback host for local development. No path, query or trailing slash —
 * every URL the broker publishes is built from it, and `iss` must match
 * byte for byte.
 */
function originFromEnv(name: string, raw: string): string | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `${name} is not a URL` };
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return { error: `${name} must be an https:// origin` };
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return { error: `${name} must be a bare origin (no path, query, credentials)` };
  }
  if (raw !== url.origin) {
    return {
      error: `${name} must be written exactly as its origin "${url.origin}" (no trailing slash)`,
    };
  }
  return url.origin;
}

function sealKeyFromEnv(name: string, raw: string): Uint8Array | { error: string } {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    return { error: `${name} must be base64` };
  }
  // Node's base64 decoder accepts both the standard and the URL-safe alphabet.
  const bytes = new Uint8Array(Buffer.from(raw, "base64"));
  if (bytes.byteLength !== 32) {
    return { error: `${name} must decode to exactly 32 bytes` };
  }
  return bytes;
}

interface CacheEntry {
  readonly path: string;
  readonly at: number;
  readonly result:
    | { ok: true; client: GoogleClient }
    | { ok: false; notSetUp: boolean; message: string };
}

/**
 * Loads {@link McpConfig} from env + the client file, caching the file read
 * for {@link CLIENT_FILE_CACHE_MS}. One instance per process.
 */
export class McpConfigLoader {
  private cache: CacheEntry | null = null;

  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly readText: ReadTextFile = nodeReadFile,
    private readonly now: () => number = Date.now,
  ) {}

  /** Resolve the configuration, or say exactly what is missing. */
  async load(): Promise<ConfigResult> {
    const raw = {
      publicUrl: this.env[MCP_ENV.publicUrl],
      adminUrl: this.env[MCP_ENV.adminUrl],
      sealKey: this.env[MCP_ENV.sealKey],
      clientFile: this.env[MCP_ENV.clientFile],
    };
    if (!raw.publicUrl || !raw.adminUrl || !raw.sealKey || !raw.clientFile) {
      const missing = (Object.keys(raw) as (keyof typeof raw)[])
        .filter((k) => !raw[k])
        .map((k) => MCP_ENV[k]);
      return {
        ok: false,
        notSetUp: false,
        message: `Remote MCP is not available on this install: the gateway lacks ${missing.join(", ")}. Remote MCP needs a Google Cloud install (gcp or gcp-firebase) upgraded with \`cms-provision upgrade\`.`,
      };
    }
    const publicUrl = originFromEnv(MCP_ENV.publicUrl, raw.publicUrl);
    if (typeof publicUrl !== "string") return this.broken(publicUrl.error);
    const adminUrl = originFromEnv(MCP_ENV.adminUrl, raw.adminUrl);
    if (typeof adminUrl !== "string") return this.broken(adminUrl.error);
    const sealKey = sealKeyFromEnv(MCP_ENV.sealKey, raw.sealKey);
    if (!(sealKey instanceof Uint8Array)) return this.broken(sealKey.error);
    const openKeys: Uint8Array[] = [sealKey];
    const rawPrevious = this.env[MCP_ENV.previousSealKey];
    if (rawPrevious) {
      const previous = sealKeyFromEnv(MCP_ENV.previousSealKey, rawPrevious);
      if (!(previous instanceof Uint8Array)) return this.broken(previous.error);
      openKeys.push(previous);
    }
    const client = await this.client(raw.clientFile);
    if (!client.ok) return client;
    return {
      ok: true,
      config: { publicUrl, adminUrl, sealKey, openKeys, google: client.client },
    };
  }

  /** Drop the cached client file (tests; the TTL covers production). */
  invalidate(): void {
    this.cache = null;
  }

  private broken(detail: string): ConfigResult {
    return {
      ok: false,
      notSetUp: false,
      message: `Remote MCP is misconfigured on this install: ${detail}. Run \`cms-provision upgrade\`.`,
    };
  }

  private async client(path: string): Promise<CacheEntry["result"]> {
    const t = this.now();
    if (this.cache && this.cache.path === path && t - this.cache.at < CLIENT_FILE_CACHE_MS) {
      return this.cache.result;
    }
    const result = await this.readClient(path);
    this.cache = { path, at: t, result };
    return result;
  }

  private async readClient(path: string): Promise<CacheEntry["result"]> {
    let text: string;
    try {
      text = await this.readText(path);
    } catch {
      return {
        ok: false,
        notSetUp: false,
        message: `Remote MCP is misconfigured on this install: the OAuth client file named by ${MCP_ENV.clientFile} cannot be read. Run \`cms-provision upgrade\`.`,
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return {
        ok: false,
        notSetUp: false,
        message:
          "Remote MCP is misconfigured on this install: the stored Google OAuth client is not JSON. An Owner saves it again under Settings → MCP.",
      };
    }
    const parsed = ClientFileSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        notSetUp: false,
        message:
          "Remote MCP is misconfigured on this install: the stored Google OAuth client needs both client_id and client_secret. An Owner saves it again under Settings → MCP.",
      };
    }
    if (!("client_id" in parsed.data)) {
      return { ok: false, notSetUp: true, message: NOT_SET_UP_MESSAGE };
    }
    return {
      ok: true,
      client: { clientId: parsed.data.client_id, clientSecret: parsed.data.client_secret },
    };
  }
}
