// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's refresh ping to the public API gateways (@caelo-cms/shared
 * gateway-refresh.ts says why it exists).
 *
 * After every publish that wrote a gateway's public database (the live
 * gateway's cms_public, the staging gateway's cms_public_staging), the
 * projection publisher calls the {@link GatewayRefresher}: one `POST` to
 * that gateway's public URL — the live site's origin, `https://<staging
 * host>` — carrying a Google-signed ID token of this admin's runtime
 * service account for that gateway's audience, minted by the metadata
 * server and reused until shortly before it expires.
 *
 * A ping never fails the publish, which has committed already. A URL the
 * admin does not know, a token the metadata server would not mint, a gateway
 * that does not answer or refuses the ping: each is logged and recorded
 * (`gateway.record_refresh`) and shown under Settings → Gateway and in
 * `get_gateway_settings`. A gateway that is on reads its state again after
 * an idle stretch by itself; an off one depends on the ping.
 *
 * The publisher awaits the pings: the post-write drain runs on the CPU of
 * the request whose write it publishes, before that write's op returns, and
 * on request-billed CPU nothing would send a ping left running after it.
 * Each ping is bounded by {@link GATEWAY_REFRESH_TIMEOUT_MS}, and the two
 * gateways are pinged at once.
 */

import type { PublishReport } from "@caelo-cms/migrations/public-projection";
import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import {
  GATEWAY_REFRESH_PATH,
  GATEWAY_REFRESH_TARGETS,
  GATEWAY_REFRESH_TOKEN_HEADER,
  type GatewayRefreshTarget,
  gatewayRefreshAudience,
  gatewayRefreshPingsOn,
} from "@caelo-cms/shared";
import { describeError } from "./ai/tools/_describe-error.js";

const SYSTEM_CTX = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "gateway-refresh",
};

/** How long one ping may take, the gateway's cold start included. */
export const GATEWAY_REFRESH_TIMEOUT_MS = 10_000;

/** A cached ID token is minted again once it expires within this margin. */
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;

const METADATA_IDENTITY =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/** An ID token for `audience`, of the service account this process runs as. */
export type IdTokenSource = (audience: string) => Promise<string>;

/** What the publisher calls after a publish. Resolves once every due ping is recorded; never rejects. */
export type GatewayRefresher = (report: Pick<PublishReport, "sections">) => Promise<void>;

/** The `exp` of a compact JWT, in milliseconds, or null when it cannot be read. */
function tokenExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    ).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * ID tokens from the metadata server (`format=full`, so the token names the
 * account's email), cached per audience until shortly before they expire.
 * A token whose expiry cannot be read is used once and not cached.
 *
 * @param now - milliseconds since the epoch (tests)
 */
export function metadataIdTokens(
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): IdTokenSource {
  const cache = new Map<string, { token: string; expiresAt: number }>();
  return async (audience) => {
    const hit = cache.get(audience);
    if (hit && hit.expiresAt - now() > TOKEN_REUSE_MARGIN_MS) return hit.token;
    const url = `${METADATA_IDENTITY}?audience=${encodeURIComponent(audience)}&format=full`;
    const res = await fetchImpl(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(GATEWAY_REFRESH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the metadata server answered HTTP ${res.status}`);
    const token = (await res.text()).trim();
    if (!token) throw new Error("the metadata server returned no token");
    const expiresAt = tokenExpiryMs(token);
    if (expiresAt !== null) cache.set(audience, { token, expiresAt });
    return token;
  };
}

/** Why a gateway refused a ping or did not answer, in words for the operator. */
function describeAnswer(status: number): string {
  if (status === 404) {
    return "the gateway refused the ping (HTTP 404): it does not take this admin's service account (CAELO_GATEWAY_REFRESH_ACCOUNT), or the URL does not reach the gateway";
  }
  if (status === 503)
    return "the gateway took the ping but could not read its published state (HTTP 503)";
  return `the gateway answered HTTP ${status}`;
}

/**
 * The refresher for this provider, or null where the gateways take no pings
 * (`gatewayRefreshPingsOn`: they have CPU between requests, or there is no
 * gateway service yet).
 */
export function createGatewayRefresher(deps: {
  readonly adapter: DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly idToken?: IdTokenSource;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): GatewayRefresher | null {
  const env = deps.env ?? process.env;
  if (!gatewayRefreshPingsOn(env.CAELO_PROVIDER)) return null;
  const installEnv = env.CAELO_ENV?.trim() ?? "";
  const fetchImpl = deps.fetch ?? fetch;
  const idToken = deps.idToken ?? metadataIdTokens(fetchImpl);
  const timeoutMs = deps.timeoutMs ?? GATEWAY_REFRESH_TIMEOUT_MS;

  const record = async (target: GatewayRefreshTarget, url: string | null, error: string | null) => {
    if (error !== null) {
      console.warn(`[gateway-refresh] ${target} gateway: ${url ?? "(no URL)"} — ${error}`);
    }
    try {
      const r = await execute(deps.registry, deps.adapter, SYSTEM_CTX, "gateway.record_refresh", {
        target,
        url,
        error: error === null ? null : error.slice(0, 2000),
      });
      if (!r.ok) throw new Error(describeError(r.error));
    } catch (e) {
      console.error(
        `[gateway-refresh] ${target} gateway: the ping's outcome could not be recorded: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const ping = async (target: GatewayRefreshTarget, base: string | null): Promise<void> => {
    if (base === null) {
      // No staging host: the staging gateway is off and nothing switches it
      // on until one is set (that write publishes and pings again).
      if (target === "staging") return;
      await record(
        target,
        null,
        "the live site has no base URL (site_defaults.site_base_url, Settings → SEO), so the admin knows no URL of the live gateway",
      );
      return;
    }
    const url = new URL(GATEWAY_REFRESH_PATH, base).toString();
    if (!installEnv) {
      await record(
        target,
        url,
        "CAELO_ENV is not set on the admin, so it cannot name the ping's audience; run `cms-provision upgrade`",
      );
      return;
    }
    let token: string;
    try {
      token = await idToken(gatewayRefreshAudience(installEnv, target));
    } catch (e) {
      await record(
        target,
        url,
        `no ID token for the ping: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { [GATEWAY_REFRESH_TOKEN_HEADER]: token },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      await record(
        target,
        url,
        `the gateway did not answer: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    // Read the body to the end, so the connection is free again.
    await res.text().catch(() => "");
    await record(target, url, res.ok ? null : describeAnswer(res.status));
  };

  return async (report) => {
    const due = GATEWAY_REFRESH_TARGETS.filter((t) => report.sections[t].length > 0);
    if (due.length === 0) return;
    let bases: Record<GatewayRefreshTarget, string | null>;
    try {
      const r = await execute(
        deps.registry,
        deps.adapter,
        SYSTEM_CTX,
        "gateway.refresh_targets",
        {},
      );
      if (!r.ok) throw new Error(describeError(r.error));
      bases = r.value as Record<GatewayRefreshTarget, string | null>;
    } catch (e) {
      const why = `the gateways' URLs could not be read: ${e instanceof Error ? e.message : String(e)}`;
      await Promise.all(due.map((t) => record(t, null, why)));
      return;
    }
    await Promise.all(due.map((t) => ping(t, bases[t])));
  };
}
