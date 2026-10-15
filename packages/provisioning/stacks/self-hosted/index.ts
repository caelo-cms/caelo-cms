// SPDX-License-Identifier: MPL-2.0

/**
 * Caelo self-hosted Pulumi entry. Composes three resources:
 *   1. `caeloConfigFile` — the generated docker-compose.yml + Caddyfile,
 *      written via local.Command on `pulumi up` and torn down on
 *      `pulumi destroy`.
 *   2. `caeloBootstrapToken` — a single-use 24h owner-bootstrap token
 *      written to `<caeloDir>/pending-token.json`. Captured as a Pulumi
 *      output so operators can read `pulumi stack output bootstrapUrl`
 *      after `pulumi up`.
 *   3. `caeloDockerCompose` — starts Postgres, runs the migrations, runs
 *      `docker compose up -d` and tears down
 *      with `docker compose down -v` on destroy.
 *
 * Why thin: Caelo's self-hosted stack is fundamentally a single Compose
 * project. Wrapping it in real Pulumi resources buys lifecycle tracking
 * + the same CLI shape we'll use for GCP / AWS / Azure in P15, without
 * forcing operators to learn a separate provisioning DSL. The
 * cms-provision CLI stays as the dev-iteration path; Pulumi owns the
 * production install.
 */

import { resolve } from "node:path";
import { local } from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import { generateBootstrapToken } from "../../dist/bootstrap-token.js";
import { generateCaddyfile, selfHostedAdminHost, selfHostedSeedDomains } from "../../dist/caddy.js";
import {
  COMPOSE_ADMIN_UPSTREAM,
  COMPOSE_GATEWAY_UPSTREAM,
  composeProjectName,
  generateDockerCompose,
  SITE_OUTPUT_ROOT,
} from "../../dist/compose.js";
import { selfHostedBootstrapScript } from "../../dist/self-hosted-roles.js";

const cfg = new pulumi.Config();
const domain = cfg.require("domain");
// #650 — the staging site's host (install setting, default staging.<domain>).
const stagingHost = cfg.get("stagingDomain") ?? `staging.${domain}`;
const ownerEmail = cfg.require("ownerEmail");
const caeloDir = cfg.get("caeloDir") ?? "./.caelo";
// #553 — same knob as every adapter; undefined = stack-contract default.
const adminMemory = cfg.get("adminMemory");
// #696 — the prebuilt, cosign-verified release images, pinned by digest
// (`ghcr.io/caelo-cms/<svc>@sha256:…`; the generator refuses anything else).
// `cms-provision init` resolves + verifies them and records them in
// .caelo/release.json; copy those values here.
const adminImage = cfg.require("adminImage");
const gatewayImage = cfg.require("gatewayImage");

const composePath = resolve(caeloDir, "docker-compose.yml");
const caddyPath = resolve(caeloDir, "Caddyfile");
// What Postgres runs on its first start: the roles + databases (compose.ts mounts it).
const bootstrapPath = resolve(caeloDir, "bootstrap.sh");
// The admin container mounts only `<caeloDir>/bootstrap/` (compose.ts).
const tokenPath = resolve(caeloDir, "bootstrap", "pending-token.json");

// Mint secrets at preview time. Pulumi's secret-handling encrypts these
// in the state file; `pulumi stack output --show-secrets postgresPassword`
// is the operator's recovery path.
const postgresPassword = pulumi.secret(randomHex(32));
// #613 — one password per application role; the gateway gets only the
// public_role one (#635: no cms_admin login).
const adminRolePassword = pulumi.secret(randomHex(32));
const publicRolePassword = pulumi.secret(randomHex(32));
// P18 — the KEK that encrypts stored provider keys.
const caeloSecretKek = pulumi.secret(randomHex(32));

const composeYaml = pulumi
  .all([postgresPassword, adminRolePassword, publicRolePassword, caeloSecretKek])
  .apply(([pgPw, adminPw, publicPw, kek]) =>
    generateDockerCompose({
      domain,
      postgresPassword: pgPw,
      rolePasswords: { admin: adminPw, public: publicPw },
      caeloSecretKek: kek,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      resendApiKey: process.env.RESEND_API_KEY,
      diskSize: "20Gi",
      ...(adminMemory ? { adminMemory } : {}),
      images: { mode: "release", admin: adminImage, gateway: gatewayImage },
      ports: { http: 80, https: 443 },
      project: composeProjectName(domain),
    }),
  );

// Same generator inputs as `cms-provision init` (#707): the admin on
// admin.<domain>, Caddy reaching the services by their Compose names.
const caddyConf = generateCaddyfile({
  ownerEmail,
  tls: "acme",
  publicSiteRoot: `${SITE_OUTPUT_ROOT}/output/production/current`,
  stagingSiteRoot: `${SITE_OUTPUT_ROOT}/output/staging/current`,
  adminUpstream: COMPOSE_ADMIN_UPSTREAM,
  gatewayUpstream: COMPOSE_GATEWAY_UPSTREAM,
  domains: selfHostedSeedDomains(domain, stagingHost),
});
const bootstrapScript = selfHostedBootstrapScript({ agent: false });

// Mint the owner bootstrap token at preview time. Captured below as a
// Pulumi output so the URL surfaces on `pulumi up`.
const tokenInfo = generateBootstrapToken();

// Stage all three files via a single local.Command so a destroy
// removes them transactionally.
const writeFiles = new local.Command("caeloConfigFile", {
  create: pulumi.interpolate`mkdir -p ${caeloDir}/bootstrap && cat > ${composePath} <<'EOF'
${composeYaml}
EOF
cat > ${caddyPath} <<'EOF'
${caddyConf}
EOF
cat > ${tokenPath} <<'EOF'
${JSON.stringify(tokenInfo, null, 2)}
EOF
cat > ${bootstrapPath} <<'EOF'
${bootstrapScript}
EOF
chmod 755 ${bootstrapPath}
`,
  delete: pulumi.interpolate`rm -f ${composePath} ${caddyPath} ${tokenPath} ${bootstrapPath}`,
  triggers: [composeYaml, caddyConf],
});

// Bring the stack up. Triggers on the file content so a `pulumi up`
// after a config change re-runs `up -d` (which is idempotent).
const composeUp = new local.Command(
  "caeloDockerCompose",
  {
    // Same order as `cms-provision init` (self-hosted-start.ts): Postgres
    // (its first start runs bootstrap.sh), the migrations with the
    // install's admin image, then everything else.
    create: pulumi.interpolate`set -e
docker compose -f ${composePath} up -d --wait postgres
for target in admin public; do
  docker compose -f ${composePath} run --rm --no-deps -T caelo-admin bun --bun /app/packages/migrations/src/migrate.ts "$target"
done
docker compose -f ${composePath} up -d --remove-orphans`,
    delete: pulumi.interpolate`docker compose -f ${composePath} down -v`,
    triggers: [composeYaml],
  },
  { dependsOn: [writeFiles] },
);

export const composeFilePath = composePath;
export const caddyFilePath = caddyPath;
export const bootstrapUrl = pulumi.interpolate`https://${selfHostedAdminHost(domain)}/setup?token=${tokenInfo.token}`;
export const bootstrapTokenExpiresAt = tokenInfo.expiresAt;
export { postgresPassword };

// Re-export so the destroy summary shows operators what they'll lose.
export const composeRunOutput = composeUp.stdout;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
