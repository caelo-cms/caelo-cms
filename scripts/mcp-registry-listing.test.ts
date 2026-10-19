// SPDX-License-Identifier: MPL-2.0
/**
 * #841 — what the MCP directories read about `@caelo-cms/mcp-server`, checked
 * offline so a broken listing fails in PR CI instead of in the release's
 * `publish-mcp-registry` job (which runs after npm is already published and
 * does not block the GitHub Release, so a failure there is easy to miss).
 *
 * L1: packages/mcp-server/server.json is valid against the official registry
 *     schema it declares. The schema is vendored (fixtures/) because tests
 *     must not hit the network; it is the schema `mcp-publisher` validates
 *     against at the version release.yml pins (PUBLISHER_SCHEMA below), so
 *     bumping the publisher without revisiting the schema fails here.
 * L2: the npm side matches: the registry only accepts the entry when the
 *     published package.json carries `mcpName` == server.json `name`, and the
 *     version it names must be the one npm just published.
 * L2b: release.ts bumps server.json and regenerates the catalogue snapshot
 *     before every release commit, and the snapshot's stamped version is the
 *     package's — so a release commit that left either behind fails here.
 * L3: the namespace is the one GitHub OIDC grants (`io.github.<repo owner>/*`).
 * L4: the environment variables the listing advertises are the ones the bins
 *     actually read, with the token marked secret.
 * L5: the tarball ships what the unconfigured server reads at runtime, plus
 *     the MPL-2.0 licence text.
 * L6: release.yml's publish job is stable-only, runs after npm is verified,
 *     holds only `contents: read` + `id-token: write`, keeps the checkout
 *     token out of .git/config, and runs a pinned, checksum-verified binary.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import * as yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PKG_DIR = resolve(REPO_ROOT, "packages/mcp-server");

/** `mcp-publisher` release → the server.json schema its `validate`/`publish` enforce. */
const PUBLISHER_SCHEMA: Record<string, string> = {
  "v1.8.1": "2025-12-11",
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface ServerJson {
  $schema: string;
  name: string;
  version: string;
  repository: { url: string; source: string; subfolder?: string };
  packages: Array<{
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
    packageArguments?: Array<{ type: string; valueHint?: string }>;
    environmentVariables?: Array<{ name: string; isRequired?: boolean; isSecret?: boolean }>;
  }>;
}

interface PackageJson {
  name: string;
  mcpName?: string;
  version: string;
  license: string;
  private?: boolean;
  repository: { url: string; directory: string };
  bin: Record<string, string>;
  files: string[];
}

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}
interface Job {
  readonly needs?: string | string[];
  readonly if?: string;
  readonly permissions?: Record<string, string>;
  readonly env?: Record<string, string>;
  readonly steps?: Step[];
  readonly strategy?: { matrix?: { package?: string[] } };
}

const serverJson = readJson<ServerJson>(resolve(PKG_DIR, "server.json"));
const pkg = readJson<PackageJson>(resolve(PKG_DIR, "package.json"));
const release = yaml.load(
  readFileSync(resolve(REPO_ROOT, ".github/workflows/release.yml"), "utf8"),
) as { jobs: Record<string, Job> };
const publishJob = release.jobs["publish-mcp-registry"];

describe("#841 MCP Registry listing", () => {
  it("L1: server.json is valid against the schema the pinned mcp-publisher enforces", () => {
    const publisher = publishJob?.env?.MCP_PUBLISHER_VERSION ?? "";
    const schemaDate = PUBLISHER_SCHEMA[publisher];
    // A new publisher pin needs its schema vendored + recorded above.
    expect(schemaDate).toBeDefined();

    const schema = readJson<{ $id: string }>(
      resolve(import.meta.dir, `__tests__/fixtures/mcp-registry-server.schema-${schemaDate}.json`),
    );
    expect(serverJson.$schema).toBe(schema.$id);

    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const ok = validate(serverJson);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("L2: package.json carries the mcpName and version the registry checks on npm", () => {
    expect(pkg.private).toBe(false);
    expect(pkg.mcpName).toBe(serverJson.name);
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages).toHaveLength(1);
    const [entry] = serverJson.packages;
    expect(entry?.registryType).toBe("npm");
    expect(entry?.identifier).toBe(pkg.name);
    expect(entry?.version).toBe(pkg.version);
    expect(entry?.transport.type).toBe("stdio");
    // The package must actually be one release.yml publishes to npm.
    expect(release.jobs["publish-npm"]?.strategy?.matrix?.package).toContain("mcp-server");
  });

  it("L2b: a release commit cannot leave server.json or the catalogue snapshot behind", () => {
    // The shipped snapshot is stamped with the release that generated it;
    // release.ts rewrites it next to every package.json bump.
    const catalogue = readJson<{ version: string }>(resolve(PKG_DIR, "power-catalogue.json"));
    expect(catalogue.version).toBe(pkg.version);

    // ...and release.ts does so before it commits, every run (not behind a
    // flag), so the release commit carries both files at the new version.
    const releaseSrc = readFileSync(resolve(REPO_ROOT, "scripts/release.ts"), "utf8");
    const mainBody = releaseSrc.slice(releaseSrc.indexOf("async function main()"));
    const at = (call: string) => mainBody.indexOf(call);
    expect(at("bumpJsonVersions(newVersion, dryRun)")).toBeGreaterThan(0);
    expect(at("bumpMcpServerJson(newVersion, dryRun)")).toBeGreaterThan(0);
    expect(at("writePowerCatalogue(newVersion, dryRun)")).toBeGreaterThan(0);
    expect(at("maybeGitCommitTag(newVersion, dryRun)")).toBeGreaterThan(
      Math.max(
        at("bumpMcpServerJson(newVersion, dryRun)"),
        at("writePowerCatalogue(newVersion, dryRun)"),
      ),
    );
    // The lockstep check (ci.yml on every PR, release.yml's gate) covers server.json.
    expect(releaseSrc.slice(releaseSrc.indexOf("function checkLockstep"))).toContain(
      "MCP_SERVER_JSON",
    );
  });

  it("L3: the name sits in the namespace GitHub OIDC grants this repository's owner", () => {
    const owner = /github\.com\/([^/]+)\//.exec(pkg.repository.url)?.[1];
    expect(owner).toBe("caelo-cms");
    expect(serverJson.name.startsWith(`io.github.${owner}/`)).toBe(true);
    expect(serverJson.repository.url).toBe(`https://github.com/${owner}/caelo-cms`);
    expect(serverJson.repository.source).toBe("github");
    expect(serverJson.repository.subfolder).toBe(pkg.repository.directory);
  });

  it("L4: the advertised variables are the ones the server reads, token marked secret", () => {
    const vars = new Map(
      (serverJson.packages[0]?.environmentVariables ?? []).map((v) => [v.name, v]),
    );
    expect([...vars.keys()].sort()).toEqual(
      ["CAELO_ADMIN_URL", "CAELO_IAP_SERVICE_ACCOUNT", "CAELO_MCP_TOKEN"].sort(),
    );
    expect(vars.get("CAELO_ADMIN_URL")?.isRequired).toBe(true);
    expect(vars.get("CAELO_MCP_TOKEN")?.isRequired).toBe(true);
    expect(vars.get("CAELO_MCP_TOKEN")?.isSecret).toBe(true);
    expect(vars.get("CAELO_IAP_SERVICE_ACCOUNT")?.isRequired).toBe(false);

    const src = (file: string) => readFileSync(resolve(PKG_DIR, "src", file), "utf8");
    for (const name of vars.keys()) {
      const readSomewhere = ["index.ts", "admin.ts", "unconfigured.ts", "ingress-auth.ts"].some(
        (f) => src(f).includes(name),
      );
      expect(readSomewhere).toBe(true);
    }
    // The optional positional is the Power-MCP switch index.ts accepts.
    expect(serverJson.packages[0]?.packageArguments?.[0]?.valueHint).toBe("admin");
    expect(src("index.ts")).toContain('command === "admin"');
  });

  it("L5: the tarball ships the runtime files and the MPL-2.0 licence text", () => {
    expect(pkg.license).toBe("MPL-2.0");
    // npm always packs a LICENSE next to package.json; keep it the root's text.
    expect(readFileSync(resolve(PKG_DIR, "LICENSE"), "utf8")).toBe(
      readFileSync(resolve(REPO_ROOT, "LICENSE"), "utf8"),
    );
    // Read at runtime by the unconfigured Power-MCP listing.
    expect(pkg.files).toContain("power-catalogue.json");
    expect(pkg.files).toContain("dist/");
    for (const target of Object.values(pkg.bin)) expect(target.startsWith("./dist/")).toBe(true);
    // Build/listing inputs stay out of what operators install.
    for (const notShipped of ["server.json", "Dockerfile", "src/"]) {
      expect(pkg.files).not.toContain(notShipped);
    }
  });

  it("L6: release.yml publishes stable releases only, after npm, least-privilege", () => {
    expect(publishJob).toBeDefined();
    if (!publishJob) return;
    expect(publishJob.needs).toBe("verify-published");
    expect(publishJob.if).toContain("contains(");
    expect(publishJob.if).toContain("'-'");
    expect(publishJob.permissions).toEqual({ contents: "read", "id-token": "write" });

    const checkout = publishJob.steps?.find((s) => s.uses?.startsWith("actions/checkout"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);

    expect(publishJob.env?.MCP_PUBLISHER_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(publishJob.env?.MCP_PUBLISHER_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const install = publishJob.steps?.map((s) => s.run ?? "").join("\n") ?? "";
    expect(install).toContain("sha256sum -c");
    expect(install).toContain("login github-oidc");
  });
});
