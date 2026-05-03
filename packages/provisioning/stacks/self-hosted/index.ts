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
 *   3. `caeloDockerCompose` — runs `docker compose up -d` and tears down
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
import { generateBootstrapToken } from "../../src/bootstrap-token.js";
import { generateCaddyfile } from "../../src/caddy.js";
import { generateDockerCompose } from "../../src/compose.js";

const cfg = new pulumi.Config();
const domain = cfg.require("domain");
const ownerEmail = cfg.require("ownerEmail");
const caeloDir = cfg.get("caeloDir") ?? "./.caelo";

const composePath = resolve(caeloDir, "docker-compose.yml");
const caddyPath = resolve(caeloDir, "Caddyfile");
const tokenPath = resolve(caeloDir, "pending-token.json");

// Mint secrets at preview time. Pulumi's secret-handling encrypts these
// in the state file; `pulumi stack output --show-secrets postgresPassword`
// is the operator's recovery path.
const postgresPassword = pulumi.secret(randomHex(32));
const minioRootUser = "caelo";
const minioRootPassword = pulumi.secret(randomHex(32));

const composeYaml = pulumi.all([postgresPassword, minioRootPassword]).apply(([pgPw, minioPw]) =>
  generateDockerCompose({
    domain,
    postgresPassword: pgPw,
    minioRootUser,
    minioRootPassword: minioPw,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    resendApiKey: process.env.RESEND_API_KEY,
    diskSize: "20Gi",
  }),
);

const caddyConf = generateCaddyfile({
  ownerEmail,
  publicSiteRoot: "/srv/caelo/output/production/current",
  stagingSiteRoot: "/srv/caelo/output/staging/current",
  adminPort: 5173,
  gatewayPort: 8090,
  domains: [
    { hostname: domain, kind: "admin", env: "production" as const },
    { hostname: domain, kind: "public", env: "production" as const },
    { hostname: `staging.${domain}`, kind: "public", env: "staging" as const },
  ],
});

// Mint the owner bootstrap token at preview time. Captured below as a
// Pulumi output so the URL surfaces on `pulumi up`.
const tokenInfo = generateBootstrapToken();

// Stage all three files via a single local.Command so a destroy
// removes them transactionally.
const writeFiles = new local.Command("caeloConfigFile", {
  create: pulumi.interpolate`mkdir -p ${caeloDir} && cat > ${composePath} <<'EOF'
${composeYaml}
EOF
cat > ${caddyPath} <<'EOF'
${caddyConf}
EOF
cat > ${tokenPath} <<'EOF'
${JSON.stringify(tokenInfo, null, 2)}
EOF
`,
  delete: pulumi.interpolate`rm -f ${composePath} ${caddyPath} ${tokenPath}`,
  triggers: [composeYaml, caddyConf],
});

// Bring the stack up. Triggers on the file content so a `pulumi up`
// after a config change re-runs `up -d` (which is idempotent).
const composeUp = new local.Command(
  "caeloDockerCompose",
  {
    create: pulumi.interpolate`docker compose -f ${composePath} up -d`,
    delete: pulumi.interpolate`docker compose -f ${composePath} down -v`,
    triggers: [composeYaml],
  },
  { dependsOn: [writeFiles] },
);

export const composeFilePath = composePath;
export const caddyFilePath = caddyPath;
export const bootstrapUrl = pulumi.interpolate`https://${domain}/setup?token=${tokenInfo.token}`;
export const bootstrapTokenExpiresAt = tokenInfo.expiresAt;
export { minioRootPassword, postgresPassword };

// Re-export so the destroy summary shows operators what they'll lose.
export const composeRunOutput = composeUp.stdout;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}
