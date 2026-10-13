// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type ComposeSpec,
  generateDockerCompose,
  releaseImageDigest,
  releaseImageRef,
} from "./compose.js";

const ADMIN = `ghcr.io/caelo-cms/admin@sha256:${"a".repeat(64)}`;
const GATEWAY = `ghcr.io/caelo-cms/gateway@sha256:${"b".repeat(64)}`;

const base: Omit<ComposeSpec, "images"> = {
  domain: "example.com",
  postgresPassword: "pgpw",
  rolePasswords: { admin: "adminpw", public: "publicpw", gateway: "gatewaypw" },
  minioRootUser: "caelo",
  minioRootPassword: "miniopw",
  caeloSecretKek: "0".repeat(64),
  anthropicApiKey: "sk-ant-x",
  diskSize: "20Gi",
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

  it("keeps Caddy and Postgres as they were", () => {
    expect(service(yaml, "caddy")).toContain("image: caddy:2-alpine");
    expect(service(yaml, "postgres")).toContain("image: postgres:16-alpine");
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
    expect(releaseImageDigest("gateway", releaseImageRef("gateway", digest))).toBe(digest);
  });

  it("refuses to build a reference from a non-digest", () => {
    expect(() => releaseImageRef("admin", "latest")).toThrow(/not an image digest/);
  });
});
