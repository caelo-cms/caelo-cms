// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  CADDY_IMAGE,
  COMPOSE_ADMIN_UPSTREAM,
  COMPOSE_APP_SERVICES,
  COMPOSE_GATEWAY_UPSTREAM,
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
  rolePasswords: { admin: "adminpw", public: "publicpw" },
  caeloSecretKek: "0".repeat(64),
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
      "    volumes:\n      - ./bootstrap:/app/.caelo\n      - ./output:/srv/caelo\n      - ./media:/data/media",
    );
    expect(yaml).not.toMatch(/- \.\/?:/);
    expect(service(yaml, "caelo-gateway")).not.toContain("volumes:");
    expect(admin).toContain('CAELO_OUTPUT_ROOT: "/srv/caelo"');
    expect(admin).toContain('MEDIA_ROOT_DIR: "/data/media"');
    expect(service(yaml, "caddy")).toContain("- ./output:/srv/caelo:ro");
  });

  it("keeps the env + secret wiring of each service", () => {
    const admin = service(yaml, "caelo-admin");
    expect(admin).toContain(
      'ADMIN_DATABASE_URL: "postgres://admin_role:adminpw@postgres:5432/cms_admin"',
    );
    expect(admin).toContain(
      'PUBLIC_ADMIN_DATABASE_URL: "postgres://admin_role:adminpw@postgres:5432/cms_public"',
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
