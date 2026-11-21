// SPDX-License-Identifier: MPL-2.0

/**
 * Where a visitor's browser streams an AI conversation from (#1654).
 *
 * On `gcp` (load balancer) and self-hosted (Caddy) the site's own origin
 * streams: `/api/*` reaches the gateway unbuffered. On `gcp-firebase` the
 * Firebase Hosting rewrite of `/api/**` buffers a response until it ends,
 * so the widget streams from the gateway's own run.app origin instead
 * (with CORS for the site's origins), the one Cloud Run gives every
 * service: `https://<service>-<project number>.<region>.run.app`.
 *
 * Nothing about it is configured: the service name and region are the
 * env the install already sets (`CAELO_GATEWAY_SERVICE`,
 * `CAELO_GATEWAY_REGION` on the admin; Cloud Run's own `K_SERVICE` on a
 * gateway), the project number and region come from the metadata server
 * of the Cloud Run instance. `CAELO_VISITOR_AI_STREAM_ORIGIN` overrides
 * everything (tests, an install behind its own streaming proxy); an empty
 * value means the site's own origin.
 */

/** The override; empty: the site's own origin. */
export const VISITOR_AI_STREAM_ORIGIN_ENV = "CAELO_VISITOR_AI_STREAM_ORIGIN";

/** The deterministic URL Cloud Run gives a service. */
export function cloudRunServiceOrigin(
  service: string,
  projectNumber: string,
  region: string,
): string {
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(service) ||
    !/^\d{1,20}$/.test(projectNumber) ||
    !/^[a-z]+-[a-z]+\d+$/.test(region)
  )
    throw new Error(`not a Cloud Run service address: ${service} / ${projectNumber} / ${region}`);
  return `https://${service}-${projectNumber}.${region}.run.app`;
}

/** The project number and region of this Cloud Run instance, from the metadata server. */
export async function cloudRunInstanceLocation(
  fetchFn: typeof fetch = fetch,
): Promise<{ readonly projectNumber: string; readonly region: string }> {
  const res = await fetchFn("http://metadata.google.internal/computeMetadata/v1/instance/region", {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`metadata server: instance/region returned HTTP ${res.status}`);
  // projects/<number>/regions/<region>
  const m = /^projects\/(\d+)\/regions\/([a-z]+-[a-z]+\d+)$/.exec((await res.text()).trim());
  if (!m) throw new Error("metadata server: instance/region has an unknown shape");
  return { projectNumber: m[1] as string, region: m[2] as string };
}

/**
 * The origin to stream from, or null for the site's own. `service` and
 * `region` name the gateway (the admin's env); without `region` the
 * instance's own (a gateway asking about itself).
 */
export async function visitorAiStreamOrigin(
  env: Readonly<Record<string, string | undefined>>,
  gateway: { readonly service: string | undefined; readonly region?: string | undefined },
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const override = env[VISITOR_AI_STREAM_ORIGIN_ENV];
  if (override !== undefined) return override.trim() === "" ? null : new URL(override).origin;
  if (env.CAELO_PROVIDER !== "gcp-firebase") return null;
  if (!gateway.service)
    throw new Error(
      "gcp-firebase: the gateway's Cloud Run service is not named (CAELO_GATEWAY_SERVICE on the admin, K_SERVICE on the gateway); run `cms-provision upgrade`",
    );
  const where = await cloudRunInstanceLocation(fetchFn);
  return cloudRunServiceOrigin(
    gateway.service,
    where.projectNumber,
    gateway.region ?? where.region,
  );
}
