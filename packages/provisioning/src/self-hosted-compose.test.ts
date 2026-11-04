// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  CADDY_IMAGE,
  COMPOSE_ADMIN_UPSTREAM,
  COMPOSE_APP_SERVICES,
  COMPOSE_GATEWAY_UPSTREAM,
  COMPOSE_MCP_AUTH_PROXY_SERVICE,
  COMPOSE_MCP_AUTH_PROXY_UPSTREAM,
  COMPOSE_POOL_BUDGET,
  COMPOSE_SCHEDULER_SERVICE,
  COMPOSE_SCHEDULER_TICK_URL,
  type ComposeSpec,
  composeProjectName,
  generateDockerCompose,
  ghcrImageDigest,
  ghcrImageRef,
} from "./compose.js";

const ADMIN = `ghcr.io/caelo-cms/admin@sha256:${"a".repeat(64)}`;
const GATEWAY = `ghcr.io/caelo-cms/gateway@sha256:${"b".repeat(64)}`;

const base: Omit<ComposeSpec, "images"> = {
  domain: "example.com",
  postgresPassword: "pgpw",
  rolePasswords: { admin: "adminpw", public: "publicpw", publicStaging: "ps" },
  caeloSecretKek: "0".repeat(64),
  dbTlsServerCertSha256: "abababababababababababababababababababababababababababababababab",
  internalSecret: "i".repeat(48),
  stagingHost: "staging.example.com",
  stagingGateSecret: "g".repeat(64),
  anthropicApiKey: "sk-ant-x",
  diskSize: "20Gi",
  ports: { http: 80, https: 443 },
  project: "caelo-example-com",
};

/** The block of one Compose service, up to the next blank line. */
function service(yaml: string, name: string): string {
  const start = yaml.indexOf(`  ${name}:\n`);
  const end = yaml.indexOf("\n\n", start);
  return yaml.slice(start, end === -1 ? undefined : end);
}

describe("self-hosted Compose — internal secret (#770)", () => {
  const yaml = generateDockerCompose({
    ...base,
    images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
  });

  it("gives the admin CAELO_INTERNAL_SECRET and the gateway nothing of it", () => {
    expect(service(yaml, "caelo-admin")).toContain(
      `      CAELO_INTERNAL_SECRET: "${"i".repeat(48)}"`,
    );
    expect(service(yaml, "caelo-gateway")).not.toContain("CAELO_INTERNAL_SECRET");
  });

  it("refuses a secret the admin would reject", () => {
    expect(() =>
      generateDockerCompose({
        ...base,
        dbTlsServerCertSha256: "abababababababababababababababababababababababababababababababab",
        internalSecret: "short",
        images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
      }),
    ).toThrow("internalSecret");
  });
});

describe("self-hosted Compose — connection budget (#1254)", () => {
  const yaml = generateDockerCompose({
    ...base,
    images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
  });

  it("starts Postgres with the max_connections the budget is computed from", () => {
    expect(service(yaml, "postgres")).toContain(
      'command: ["postgres", "-c", "max_connections=100", ',
    );
  });

  it("serves TLS with the install's own certificate, never a key it does not own (#1338)", () => {
    const pg = service(yaml, "postgres");
    expect(pg).toContain('"-c", "ssl=on"');
    expect(pg).toContain("- ./postgres-tls/server.crt:/caelo-tls/server.crt:ro");
    expect(pg).toContain("- ./postgres-tls/server.key:/caelo-tls/server.key:ro");
    // The bind mount keeps the host's owner; Postgres only reads its own key.
    expect(pg).toContain("install -o postgres -g postgres -m 0600 /caelo-tls/server.key");
    expect(pg).toContain('exec docker-entrypoint.sh \\"$$@\\"');
    // Only Postgres sees the server key; the CA key never leaves .caelo/.
    expect(yaml.replace(pg, "")).not.toContain("server.key");
    expect(yaml).not.toContain("ca.key");
  });

  it("sizes the admin's two pools and the gateway's one", () => {
    expect(service(yaml, "caelo-admin")).toContain(
      `      CAELO_DB_POOL_MAX: "${COMPOSE_POOL_BUDGET.budget.adminPoolMax}"`,
    );
    expect(service(yaml, "caelo-admin")).toContain('      CAELO_DB_PUBLIC_POOL_MAX: "4"');
    expect(service(yaml, "caelo-gateway")).toContain('      CAELO_DB_PUBLIC_POOL_MAX: "2"');
    expect(service(yaml, "caelo-gateway")).not.toContain("CAELO_DB_POOL_MAX:");
  });
});

describe("self-hosted Compose — database certificate renewal (#1338)", () => {
  const render = (digest: string) =>
    generateDockerCompose({
      ...base,
      dbTlsServerCertSha256: digest,
      images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
    });

  it("carries the server certificate's digest on Postgres, so a renewal recreates it", () => {
    const before = service(render("a".repeat(64)), "postgres");
    const after = service(render("c".repeat(64)), "postgres");
    expect(before).toContain(`CAELO_DB_TLS_SERVER_CERT_SHA256: "${"a".repeat(64)}"`);
    expect(after).not.toBe(before);
  });

  it("refuses a value that is no SHA-256 digest", () => {
    expect(() => render("not-a-digest")).toThrow("dbTlsServerCertSha256");
  });
});

describe("self-hosted Compose — release images (#696)", () => {
  const yaml = generateDockerCompose({
    ...base,
    images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
  });

  it("runs the admin + gateway from the digest-pinned GHCR release images", () => {
    expect(service(yaml, "caelo-admin")).toContain(`image: ${ADMIN}`);
    expect(service(yaml, "caelo-gateway")).toContain(`image: ${GATEWAY}`);
  });

  it("mounts no source checkout and runs no build tooling", () => {
    expect(yaml).not.toContain("../..");
    expect(yaml).not.toContain("oven/bun");
    expect(yaml).not.toContain("working_dir");
    expect(yaml).not.toMatch(/^\s+command: bun/m);
    expect(yaml).not.toContain("DEV MODE");
  });

  it("mounts the bootstrap-token, site output + media dirs, never .caelo/ with its secrets", () => {
    const admin = service(yaml, "caelo-admin");
    expect(admin).toContain(
      "    volumes:\n      - ./bootstrap:/app/.caelo\n      - ./output:/srv/caelo\n      - ./media:/data/media\n      - ./postgres-tls/ca.crt:/etc/caelo/db-ca/self-hosted-ca.pem:ro",
    );
    expect(yaml).not.toMatch(/- \.\/?:/);
    // The gateway mounts the database CA (#1338) and nothing else.
    expect(service(yaml, "caelo-gateway")).toContain(
      "    volumes:\n      - ./postgres-tls/ca.crt:/etc/caelo/db-ca/self-hosted-ca.pem:ro\n    restart:",
    );
    expect(admin).toContain('CAELO_OUTPUT_ROOT: "/srv/caelo"');
    expect(admin).toContain('MEDIA_ROOT_DIR: "/data/media"');
    expect(service(yaml, "caddy")).toContain("- ./output:/srv/caelo:ro");
  });

  it("keeps the env + secret wiring of each service", () => {
    const admin = service(yaml, "caelo-admin");
    expect(admin).toContain(
      'ADMIN_DATABASE_URL: "postgres://admin_role:adminpw@postgres:5432/cms_admin?sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/self-hosted-ca.pem"',
    );
    expect(admin).toContain(
      'PUBLIC_ADMIN_DATABASE_URL: "postgres://admin_role:adminpw@postgres:5432/cms_public?sslmode=verify-full&sslrootcert=/etc/caelo/db-ca/self-hosted-ca.pem"',
    );
    expect(admin).toContain(`CAELO_SECRET_KEK: "${"0".repeat(64)}"`);
    expect(admin).toContain('CAELO_SITE_URL: "https://example.com"');
    expect(admin).toContain('PORT: "5173"');
    expect(admin).toContain('ANTHROPIC_API_KEY: "sk-ant-x"');
    const gateway = service(yaml, "caelo-gateway");
    expect(gateway).toContain('GATEWAY_PORT: "8090"');
    expect(gateway).not.toMatch(/ADMIN_DATABASE|adminpw|CAELO_SECRET_KEK/);
  });

  it("runs Caddy on the pinned image the Caddyfile is validated against, Postgres as before", () => {
    expect(service(yaml, "caddy")).toContain(`image: ${CADDY_IMAGE}`);
    expect(CADDY_IMAGE).toMatch(/^caddy:\d+\.\d+\.\d+-alpine$/);
    expect(service(yaml, "postgres")).toContain("image: postgres:16-alpine");
  });

  it("mounts the bootstrap script Postgres runs on its first start", () => {
    expect(service(yaml, "postgres")).toContain(
      "- ./bootstrap.sh:/docker-entrypoint-initdb.d/00_bootstrap.sh:ro",
    );
  });

  it("has no pgBackRest sidecar and bind-mounts only paths the CLI creates (#707)", () => {
    expect(yaml).not.toContain("pgbackrest");
    expect(yaml).not.toContain("caelo-pg-backups");
    // Each is written (files) or created (dirs) by `init` / `up`; a path
    // nothing creates becomes an empty root-owned dir under Docker.
    const hostPaths = new Set([...yaml.matchAll(/- \.\/([\w.-]+):/g)].map((m) => m[1]));
    expect([...hostPaths].sort()).toEqual([
      "Caddyfile",
      "bootstrap",
      "bootstrap.sh",
      "media",
      "output",
    ]);
  });

  it("names no containers, so an install can share a host with other stacks (#707)", () => {
    expect(yaml).not.toContain("container_name");
  });

  it("defines every service restore stops and Caddy proxies to (#707)", () => {
    for (const name of COMPOSE_APP_SERVICES) expect(yaml).toContain(`\n  ${name}:\n`);
    expect(COMPOSE_ADMIN_UPSTREAM).toBe("caelo-admin:5173");
    expect(COMPOSE_GATEWAY_UPSTREAM).toBe("caelo-gateway:8090");
    expect(service(yaml, "caelo-admin")).toContain('PORT: "5173"');
    expect(service(yaml, "caelo-gateway")).toContain('GATEWAY_PORT: "8090"');
  });

  it("names its Compose project, so two installs on one host never share containers or volumes", () => {
    expect(yaml).toContain("\nname: caelo-example-com\n");
    expect(composeProjectName("Shop.Example.co.uk")).toBe("caelo-shop-example-co-uk");
    expect(() =>
      generateDockerCompose({
        ...base,
        project: "Bad Name",
        images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
      }),
    ).toThrow(/not a Compose project name/);
  });

  it("puts a non-443 HTTPS port into the admin's site URL", () => {
    expect(service(yaml, "caelo-admin")).toContain('CAELO_SITE_URL: "https://example.com"');
    const ported = generateDockerCompose({
      ...base,
      ports: { http: 18080, https: 18443 },
      images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
    });
    expect(service(ported, "caelo-admin")).toContain('CAELO_SITE_URL: "https://example.com:18443"');
  });

  it("publishes Caddy on the configured host ports", () => {
    expect(service(yaml, "caddy")).toContain('ports: ["80:80", "443:443"]');
    const custom = generateDockerCompose({
      ...base,
      ports: { http: 18080, https: 18443 },
      images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
    });
    expect(service(custom, "caddy")).toContain('ports: ["18080:80", "18443:443"]');
    for (const ports of [
      { http: 0, https: 443 },
      { http: 80, https: 70000 },
      { http: 8080, https: 8080 },
    ]) {
      expect(() =>
        generateDockerCompose({
          ...base,
          ports,
          images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
        }),
      ).toThrow();
    }
  });

  it("refuses a tag, a foreign repository or a malformed digest", () => {
    for (const admin of [
      "ghcr.io/caelo-cms/admin:latest",
      `ghcr.io/evil/admin@sha256:${"a".repeat(64)}`,
      "ghcr.io/caelo-cms/admin@sha256:abc",
      GATEWAY,
    ]) {
      expect(() =>
        generateDockerCompose({ ...base, images: { mode: "release", admin, gateway: GATEWAY } }),
      ).toThrow(/is not ghcr\.io\/caelo-cms\/admin@sha256/);
    }
  });
});

describe("self-hosted Compose — dev mode", () => {
  const yaml = generateDockerCompose({ ...base, images: { mode: "dev" } });

  it("bind-mounts the checkout, clearly labelled as contributor-only", () => {
    for (const name of ["caelo-admin", "caelo-gateway"]) {
      const block = service(yaml, name);
      expect(block).toContain("DEV MODE");
      expect(block).toContain("- ../..:/app");
      expect(block).not.toMatch(/command:.*\n\s+- /);
      expect(block).not.toContain("ghcr.io");
    }
  });

  it("also mounts the bootstrap-token dir into the admin", () => {
    expect(service(yaml, "caelo-admin")).toContain(
      "    volumes:\n      - ../..:/app\n      - ./bootstrap:/app/.caelo",
    );
  });

  it("keeps the same env wiring as release mode", () => {
    const release = generateDockerCompose({
      ...base,
      images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
    });
    const envOf = (y: string, name: string) =>
      service(y, name).slice(service(y, name).indexOf("environment:"));
    for (const name of ["caelo-admin", "caelo-gateway"]) {
      expect(envOf(yaml, name)).toBe(envOf(release, name));
    }
  });
});

describe("release image references", () => {
  it("round-trips a digest", () => {
    const digest = `sha256:${"c".repeat(64)}`;
    expect(ghcrImageDigest("gateway", ghcrImageRef("gateway", digest))).toBe(digest);
  });

  it("refuses to build a reference from a non-digest", () => {
    expect(() => ghcrImageRef("admin", "latest")).toThrow(/not an image digest/);
  });
});

describe("self-hosted Compose — the host update agent (#696 Phase 4c)", () => {
  const images = { mode: "release", admin: ADMIN, gateway: GATEWAY } as const;

  it("publishes no database port without the agent, and tells the admin its provider", () => {
    const yaml = generateDockerCompose({ ...base, images });
    expect(service(yaml, "postgres")).not.toContain("ports:");
    expect(yaml).not.toContain("AGENT_ROLE_PASSWORD");
    expect(service(yaml, "caelo-admin")).toContain('CAELO_PROVIDER: "self-hosted"');
  });

  it("publishes Postgres for the agent on the loopback interface only", () => {
    const yaml = generateDockerCompose({
      ...base,
      images,
      agent: { dbPort: 15432, dbPassword: 'ag"pw' },
    });
    const pg = service(yaml, "postgres");
    expect(pg).toContain('    ports: ["127.0.0.1:15432:5432"]');
    expect(pg).toContain('AGENT_ROLE_PASSWORD: "ag\\"pw"');
    // The only published ports: Caddy's, and the agent's loopback one.
    expect(yaml.match(/ports:/g)?.length).toBe(2);
    expect(yaml).not.toMatch(/"(0\.0\.0\.0:)?15432:5432"/);
    // Only Postgres sees the agent's password.
    expect(service(yaml, "caelo-admin")).not.toContain('ag\\"pw');
    expect(service(yaml, "caelo-gateway")).not.toContain("AGENT");
  });

  it("refuses a privileged or invalid port", () => {
    expect(() =>
      generateDockerCompose({ ...base, images, agent: { dbPort: 5432.5, dbPassword: "x" } }),
    ).toThrow();
    expect(() =>
      generateDockerCompose({ ...base, images, agent: { dbPort: 443, dbPassword: "x" } }),
    ).toThrow(/between 1024 and 65535/);
  });
});

describe("self-hosted Compose — the MCP-Auth-Proxy (#1328)", () => {
  const PROXY = `ghcr.io/caelo-cms/mcp-auth-proxy@sha256:${"c".repeat(64)}`;
  const yaml = generateDockerCompose({
    ...base,
    images: { mode: "release", admin: ADMIN, gateway: GATEWAY, "mcp-auth-proxy": PROXY },
  });
  const proxy = service(yaml, COMPOSE_MCP_AUTH_PROXY_SERVICE);

  it("runs the digest-pinned release image on the port Caddy proxies to", () => {
    expect(proxy).toContain(`image: ${PROXY}`);
    expect(proxy).toContain('MCP_AUTH_PROXY_PORT: "8095"');
    expect(COMPOSE_MCP_AUTH_PROXY_UPSTREAM).toBe("caelo-mcp-auth-proxy:8095");
  });

  it("says remote MCP is unavailable here and trusts Caddy as the one hop", () => {
    expect(proxy).toContain('CAELO_REMOTE_MCP: "unavailable"');
    expect(proxy).toContain('CAELO_TRUSTED_PROXY_HOPS: "1"');
    expect(proxy).toContain('CAELO_PROVIDER: "self-hosted"');
  });

  it("gets no database URL, no secret, no mount and no dependency on Postgres", () => {
    expect(proxy).not.toMatch(/DATABASE|PASSWORD|SECRET|KEK|postgres:\/\/|volumes:|depends_on/);
    expect(proxy).not.toContain("adminpw");
    expect(proxy).not.toContain("publicpw");
  });

  it("runs locked down: read-only root, no capabilities, no privilege escalation", () => {
    expect(proxy).toContain("read_only: true");
    expect(proxy).toContain('cap_drop: ["ALL"]');
    expect(proxy).toContain('security_opt: ["no-new-privileges:true"]');
  });

  it("is absent for a release recorded before the proxy shipped", () => {
    const old = generateDockerCompose({
      ...base,
      images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
    });
    expect(old).not.toContain(COMPOSE_MCP_AUTH_PROXY_SERVICE);
    expect(old).toContain("\n\nvolumes:\n");
  });

  it("runs the checkout's proxy in dev mode", () => {
    const dev = generateDockerCompose({ ...base, images: { mode: "dev" } });
    expect(service(dev, COMPOSE_MCP_AUTH_PROXY_SERVICE)).toContain(
      "command: bun run apps/mcp-auth-proxy/src/server.ts",
    );
  });

  it("refuses a proxy image that is not a digest-pinned GHCR reference", () => {
    expect(() =>
      generateDockerCompose({
        ...base,
        images: {
          mode: "release",
          admin: ADMIN,
          gateway: GATEWAY,
          "mcp-auth-proxy": "ghcr.io/caelo-cms/mcp-auth-proxy:latest",
        },
      }),
    ).toThrow(/mcp-auth-proxy image/);
  });
});

describe("self-hosted Compose — the scheduler tick (#1140)", () => {
  const yaml = generateDockerCompose({
    ...base,
    images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
  });
  const scheduler = service(yaml, COMPOSE_SCHEDULER_SERVICE);

  it("runs the admin image's clock against the admin's tick endpoint", () => {
    expect(scheduler).toContain(`image: ${ADMIN}`);
    expect(scheduler).toContain(
      'command: ["bun", "--bun", "/app/packages/admin-core/src/scheduler/clock.ts"]',
    );
    expect(COMPOSE_SCHEDULER_TICK_URL).toBe("http://caelo-admin:5173/api/internal/scheduler/tick");
    expect(scheduler).toContain(`CAELO_SCHEDULER_TICK_URL: "${COMPOSE_SCHEDULER_TICK_URL}"`);
    expect(scheduler).toContain("depends_on: [caelo-admin]");
  });

  it("ticks every 5 minutes by default and follows the knob", () => {
    expect(scheduler).toContain('CAELO_SCHEDULER_INTERVAL_MINUTES: "5"');
    const fast = generateDockerCompose({
      ...base,
      schedulerIntervalMinutes: 1,
      images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
    });
    expect(service(fast, COMPOSE_SCHEDULER_SERVICE)).toContain(
      'CAELO_SCHEDULER_INTERVAL_MINUTES: "1"',
    );
  });

  it("refuses an interval outside 1-15 minutes", () => {
    for (const bad of [0, 16, 2.5]) {
      expect(() =>
        generateDockerCompose({
          ...base,
          schedulerIntervalMinutes: bad,
          images: { mode: "release", admin: ADMIN, gateway: GATEWAY },
        }),
      ).toThrow("schedulerIntervalMinutes");
    }
  });

  it("holds only the internal secret it signs with: no database, no KEK, no mount", () => {
    expect(scheduler).toContain(`CAELO_INTERNAL_SECRET: "${"i".repeat(48)}"`);
    expect(scheduler).not.toMatch(/DATABASE|PASSWORD|KEK|postgres:\/\/|volumes:/);
    expect(scheduler).not.toContain("adminpw");
    expect(scheduler).not.toContain("0".repeat(64));
  });

  it("runs locked down: read-only root, no capabilities, no privilege escalation", () => {
    expect(scheduler).toContain("read_only: true");
    expect(scheduler).toContain('cap_drop: ["ALL"]');
    expect(scheduler).toContain('security_opt: ["no-new-privileges:true"]');
  });

  it("runs the checkout's clock in dev mode", () => {
    const dev = generateDockerCompose({ ...base, images: { mode: "dev" } });
    expect(service(dev, COMPOSE_SCHEDULER_SERVICE)).toContain(
      "command: bun run packages/admin-core/src/scheduler/clock.ts",
    );
  });

  it("is part of every rendered Compose file, so an upgrade of an older install adds it", () => {
    // self-hosted-upgrade.ts rolls onto renderCompose(<new images>), which is
    // this generator: the next upgrade of an install without the service
    // writes a Compose file that has it, and `docker compose up -d` starts it.
    expect(yaml).toContain(`\n  ${COMPOSE_SCHEDULER_SERVICE}:\n`);
  });
});
