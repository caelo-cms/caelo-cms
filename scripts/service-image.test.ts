// SPDX-License-Identifier: MPL-2.0

/**
 * Unit tests for the minimal service images (issue #1327,
 * scripts/service-image.ts): the run-time closure, the content allowlist,
 * the non-root and no-shell rules, digest pinning, the bundle SBOM — and the
 * gateway's own Dockerfile + spec, including the NODE_ENV regression a
 * bundled gateway had (the bundler had removed the `Secure` cookie flag).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import gatewaySpec from "../apps/api-gateway/image.ts";
import proxySpec from "../apps/mcp-auth-proxy/image.ts";
import {
  allowedPatterns,
  BUNDLE_LICENSES,
  BUNDLE_SBOM,
  bundledPackages,
  bundleService,
  closureProblems,
  configProblems,
  contentProblems,
  cycloneDx,
  licenseNotice,
  packageFiles,
  runtimeBase,
  runtimeClosure,
  type ServiceImageSpec,
} from "./service-image.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DIGEST = `sha256:${"a".repeat(64)}`;

let fixture: string;

function write(rel: string, content: string): void {
  const path = join(fixture, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function pkg(rel: string, json: Record<string, unknown>): void {
  write(join(rel, "package.json"), JSON.stringify(json));
}

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "service-image-"));
  // A workspace package linked from the root node_modules (hoisted linker).
  pkg("packages/sdk", { name: "@x/sdk", dependencies: { lib: "1", nested: "1" } });
  write("packages/sdk/src/index.ts", "export {};");
  write("packages/sdk/src/index.test.ts", "test");
  write("packages/sdk/src/__tests__/a.ts", "test");
  write("packages/sdk/dist/index.js", "export {};");
  write("packages/sdk/dist/index.d.ts", "export {};");
  mkdirSync(join(fixture, "node_modules/@x"), { recursive: true });
  symlinkSync(join(fixture, "packages/sdk"), join(fixture, "node_modules/@x/sdk"));
  // A hoisted npm package with an optional binding per libc.
  pkg("node_modules/lib", {
    name: "lib",
    version: "1.0.0",
    optionalDependencies: { "lib-gnu": "1", "lib-musl": "1", "lib-absent": "1" },
  });
  write("node_modules/lib/index.js", "");
  pkg("node_modules/lib-gnu", { name: "lib-gnu", version: "1.0.0", libc: ["glibc"] });
  pkg("node_modules/lib-musl", { name: "lib-musl", version: "1.0.0", libc: ["musl"] });
  // A version conflict installed inside its importer.
  pkg("packages/sdk/node_modules/nested", { name: "nested", version: "2.0.0" });
  write("packages/sdk/node_modules/nested/index.js", "");
  pkg("node_modules/nested", { name: "nested", version: "1.0.0" });
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("runtimeClosure", () => {
  it("follows dependencies the way the hoisted install resolves them", () => {
    const closure = runtimeClosure(fixture, ["@x/sdk"], "glibc");
    expect(closure.map((p) => [p.imageDir, p.workspace])).toEqual([
      ["node_modules/@x/sdk", true],
      ["node_modules/@x/sdk/node_modules/nested", false],
      ["node_modules/lib", false],
      ["node_modules/lib-gnu", false],
    ]);
  });

  it("stages the binding of the image's libc only", () => {
    const closure = runtimeClosure(fixture, ["lib"], "musl");
    expect(closure.map((p) => p.imageDir)).toEqual(["node_modules/lib", "node_modules/lib-musl"]);
  });

  it("refuses a dependency that is not installed", () => {
    pkg("node_modules/broken", { name: "broken", dependencies: { missing: "1" } });
    expect(() => runtimeClosure(fixture, ["broken"], "glibc")).toThrow(/missing.*not installed/);
    expect(() => runtimeClosure(fixture, ["nope"], "glibc")).toThrow(/nope is not installed/);
  });
});

describe("packageFiles", () => {
  it("copies a workspace package's sources and built JS, never tests or types", () => {
    const [sdk] = runtimeClosure(fixture, ["@x/sdk"], "glibc");
    expect(sdk && packageFiles(sdk)).toEqual(["dist/index.js", "package.json", "src/index.ts"]);
  });

  it("copies an npm package whole, but not its nested installs", () => {
    write("node_modules/lib/node_modules/inner/index.js", "");
    const lib = runtimeClosure(fixture, ["lib"], "glibc").find((p) => p.name === "lib");
    expect(lib && packageFiles(lib)).toEqual(["index.js", "package.json"]);
  });
});

describe("closureProblems", () => {
  it("names packages missing from either side; globs match platform bindings", () => {
    const lib = runtimeClosure(fixture, ["lib"], "glibc");
    expect(closureProblems(lib, ["node_modules/lib", "node_modules/zod"])).toEqual([
      "node_modules/lib-gnu is in the run-time closure but not in the spec's nodeModules",
      "node_modules/zod is in the spec's nodeModules but not in the run-time closure",
    ]);
    expect(closureProblems(lib, ["node_modules/lib", "node_modules/lib-*"])).toEqual([]);
  });
});

const SPEC: ServiceImageSpec = {
  dockerfile: "Dockerfile",
  appRoot: "/app",
  bundle: { entrypoints: [], outdir: "apps/svc/dist", external: [] },
  runtimePackages: [],
  libc: "glibc",
  nodeModules: ["node_modules/zod"],
  copy: ["packages/plugins/*/manifest.json"],
  binaries: [{ path: "usr/local/bin/bun", purl: null }],
  extraFiles: [],
  require: ["app/apps/svc/dist/server.js"],
};

describe("contentProblems", () => {
  const base = ["etc/passwd", "usr/lib/libc.so.6"];
  const added = [
    "usr/local/bin/bun",
    "app/apps/svc/dist/server.js",
    "app/node_modules/zod/package.json",
    "app/packages/plugins/forms/manifest.json",
  ];
  const good = [...base, ...added];
  const check = (over: { files?: string[]; baseFiles?: string[]; added?: string[] }) =>
    contentProblems({ spec: SPEC, files: good, baseFiles: base, added, ...over });

  it("accepts an image of base files and allowlisted files", () => {
    expect(check({})).toEqual([]);
  });

  it("fails on any added file outside the allowlist", () => {
    const extra = ["app/packages/admin-core/src/index.ts", "app/node_modules/sharp/x.js"];
    expect(check({ files: [...good, ...extra], added: [...added, ...extra] })).toEqual([
      "app/packages/admin-core/src/index.ts: not in the allowlist",
      "app/node_modules/sharp/x.js: not in the allowlist",
    ]);
  });

  it("fails when the image overwrites or deletes a file of its base", () => {
    expect(check({ added: [...added, "etc/passwd", "usr/lib/.wh.libc.so.6"] })).toEqual([
      "etc/passwd: the image replaces a file of its base",
      "usr/lib/.wh.libc.so.6: the image deletes a file of its base",
    ]);
  });

  it("fails on a shell even when the base image carries it", () => {
    const files = [...good, "bin/sh", "usr/bin/busybox"];
    const problems = check({ files, baseFiles: [...base, "bin/sh"] });
    expect(problems).toContain("bin/sh: no shell or tool of this kind may be in the image");
    expect(problems).toContain(
      "usr/bin/busybox: no shell or tool of this kind may be in the image",
    );
  });

  it("fails when a required file is missing", () => {
    const files = good.filter((f) => !f.endsWith("server.js"));
    expect(check({ files })).toEqual(["app/apps/svc/dist/server.js: required, but missing"]);
  });
});

describe("configProblems", () => {
  const entry = { Entrypoint: ["/usr/local/bin/bun"] };
  it("accepts a numeric non-root user", () => {
    expect(configProblems({ ...entry, User: "65532:65532" })).toEqual([]);
    expect(configProblems({ ...entry, User: "65532" })).toEqual([]);
  });
  it.each(["", "0", "0:0", "root", "nonroot"])("refuses user %p", (User) => {
    expect(configProblems({ ...entry, User })).toHaveLength(1);
  });
  it("refuses an image without an exec-form entrypoint", () => {
    expect(configProblems({ User: "65532", Entrypoint: null })).toEqual([
      "has no exec-form ENTRYPOINT",
    ]);
  });
});

describe("runtimeBase", () => {
  it("is the last FROM, pinned by digest", () => {
    expect(runtimeBase(`FROM a@${DIGEST} AS b\nFROM --platform=$X c@${DIGEST} AS runtime\n`)).toBe(
      `c@${DIGEST}`,
    );
  });
  it("refuses a tag-only base", () => {
    expect(() => runtimeBase("FROM gcr.io/distroless/cc:nonroot AS runtime\n")).toThrow(
      /not pinned/,
    );
  });
  it("refuses a tag-only builder stage too", () => {
    expect(() => runtimeBase(`FROM oven/bun:1.4.4 AS builder\nFROM c@${DIGEST}\n`)).toThrow(
      "not pinned by digest: oven/bun:1.4.4",
    );
  });
});

describe("bundle SBOM", () => {
  it("lists every npm package behind the bundle's inputs, once per version", () => {
    pkg("node_modules/@s/one", { name: "@s/one", version: "1.2.3" });
    const packages = bundledPackages(fixture, [
      "packages/sdk/src/index.ts",
      "node_modules/@s/one/lib/a.js",
      "node_modules/@s/one/lib/b.js",
      "node_modules/lib/index.js",
      "packages/sdk/node_modules/nested/index.js",
    ]);
    expect(packages).toEqual([
      { name: "@s/one", version: "1.2.3", dir: "node_modules/@s/one" },
      { name: "lib", version: "1.0.0", dir: "node_modules/lib" },
      { name: "nested", version: "2.0.0", dir: "packages/sdk/node_modules/nested" },
    ]);
    const bom = cycloneDx(packages, [
      { path: "usr/local/bin/deno", purl: "pkg:cargo/deno@2.9.8" },
      { path: "usr/local/bin/bun", purl: null },
    ]);
    expect((bom.components as Array<{ purl: string }>).map((c) => c.purl)).toEqual([
      "pkg:npm/%40s/one@1.2.3",
      "pkg:npm/lib@1.0.0",
      "pkg:npm/nested@2.0.0",
      "pkg:cargo/deno@2.9.8",
    ]);
  });
});

describe("licenseNotice", () => {
  it("carries each bundled package's licence text under its name and version", () => {
    pkg("node_modules/mit", { name: "mit", version: "1.0.0", license: "MIT" });
    write("node_modules/mit/LICENSE", "MIT text\n");
    pkg("node_modules/bare", { name: "bare", version: "2.0.0", license: "ISC" });
    const notice = licenseNotice(fixture, [
      { name: "mit", version: "1.0.0", dir: "node_modules/mit" },
      { name: "bare", version: "2.0.0", dir: "node_modules/bare" },
    ]);
    expect(notice).toContain("mit@1.0.0 (MIT)\n===============\nMIT text\n");
    expect(notice).toContain("bare@2.0.0 (ISC)");
    expect(notice).toContain("The package ships no licence text; package.json declares ISC.");
  });

  it("refuses a package with neither a licence file nor a licence field", () => {
    pkg("node_modules/unknown", { name: "unknown", version: "1.0.0" });
    expect(() =>
      licenseNotice(fixture, [{ name: "unknown", version: "1.0.0", dir: "node_modules/unknown" }]),
    ).toThrow(/no licence file and no licence field/);
  });
});

describe("the gateway image", () => {
  const dockerfile = readFileSync(resolve(REPO_ROOT, gatewaySpec.dockerfile), "utf8");

  it("pins every base image by digest", () => {
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    expect(froms.length).toBeGreaterThan(1);
    for (const ref of froms) expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(runtimeBase(dockerfile)).toStartWith("gcr.io/distroless/");
  });

  it("runs as the distroless non-root user, with an exec-form entrypoint", () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    expect(runtime).toContain("\nUSER 65532:65532\n");
    expect(runtime).toContain('\nENTRYPOINT ["/usr/local/bin/bun"]\n');
    expect(runtime).not.toMatch(/^RUN /m);
  });

  it("lists the Deno version the Dockerfile copies", () => {
    const tag = /^FROM denoland\/deno:bin-(\S+)@/m.exec(dockerfile)?.[1];
    const deno = gatewaySpec.binaries.find((b) => b.path === "usr/local/bin/deno");
    expect(deno?.purl).toBe(`pkg:cargo/deno@${tag}`);
  });

  it("ships the run-time closure its spec lists", () => {
    // The native binding is per platform; the image's own (linux, glibc)
    // binding is checked when the Dockerfile stages it.
    const closure = runtimeClosure(REPO_ROOT, gatewaySpec.runtimePackages, gatewaySpec.libc).filter(
      (p) => !p.name.startsWith("@oxc-parser/binding-"),
    );
    const listed = gatewaySpec.nodeModules.filter((d) => !d.includes("@oxc-parser/binding-"));
    expect(closureProblems(closure, listed)).toEqual([]);
  });

  it("is gated in release-images.yml before anything is pushed", () => {
    const workflow = readFileSync(
      resolve(REPO_ROOT, ".github/workflows/release-images.yml"),
      "utf8",
    );
    const app = gatewaySpec.appRoot;
    expect(workflow).toContain("spec: apps/api-gateway/image.ts");
    expect(workflow).toContain(`sbom: ${app}/${gatewaySpec.bundle.outdir}/${BUNDLE_SBOM}`);
    const gates = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow shell text under test
      'bun scripts/service-image.ts verify "${SPEC}" "${IMAGE}"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow shell text under test
      '--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 "${IMAGE}"',
      "--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 /sbom/bundle.cdx.json",
      "apps/api-gateway/dist/image-self-check.js",
      "/api/_caelo/health?deep=1",
    ];
    const push = workflow.indexOf("- name: Build + push");
    for (const gate of gates) {
      const at = workflow.indexOf(gate);
      expect(at, gate).toBeGreaterThan(-1);
      expect(at, `${gate} runs before Build + push`).toBeLessThan(push);
    }
  });

  it("never allowlists sharp or the admin's packages", () => {
    for (const pattern of allowedPatterns(gatewaySpec)) {
      expect(pattern).not.toMatch(/sharp|admin-core|query-api|migrations/);
    }
  });

  it("bundles a server that reads NODE_ENV at run time", async () => {
    const out = mkdtempSync(join(tmpdir(), "service-image-bundle-"));
    try {
      await bundleService(REPO_ROOT, gatewaySpec, out);
      const code = readdirSync(out)
        .filter((f) => f.endsWith(".js"))
        .map((f) => readFileSync(join(out, f), "utf8"))
        .join("\n");
      // apps/api-gateway/src/server.ts sessionCookieHeader.
      expect(code).toContain(
        'if (process.env.NODE_ENV === "production")\n    flags.push("Secure")',
      );
      expect(code).not.toContain('"development" === "production"');
      const sbom = JSON.parse(readFileSync(join(out, BUNDLE_SBOM), "utf8")) as {
        components: Array<{ name: string }>;
      };
      expect(sbom.components.map((c) => c.name)).toContain("drizzle-orm");
      expect(sbom.components.map((c) => c.name)).toContain("deno");
      expect(readFileSync(join(out, BUNDLE_LICENSES), "utf8")).toContain("drizzle-orm@");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("the MCP-Auth-Proxy image (#1328)", () => {
  const dockerfile = readFileSync(resolve(REPO_ROOT, proxySpec.dockerfile), "utf8");

  it("pins every base image by digest, on the gateway's distroless base", () => {
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    for (const ref of froms) expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
    const gateway = readFileSync(resolve(REPO_ROOT, gatewaySpec.dockerfile), "utf8");
    expect(runtimeBase(dockerfile)).toBe(runtimeBase(gateway));
  });

  it("runs as the distroless non-root user, with an exec-form entrypoint", () => {
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    expect(runtime).toContain("\nUSER 65532:65532\n");
    expect(runtime).toContain('\nENTRYPOINT ["/usr/local/bin/bun"]\n');
    expect(runtime).not.toMatch(/^RUN /m);
  });

  it("carries one bundle and the Bun binary: no packages on disk, no Deno, no database CA", () => {
    expect(proxySpec.runtimePackages).toEqual([]);
    expect(proxySpec.nodeModules).toEqual([]);
    expect(proxySpec.copy).toEqual([]);
    expect(proxySpec.extraFiles).toEqual([]);
    expect(proxySpec.binaries.map((b) => b.path)).toEqual(["usr/local/bin/bun"]);
  });

  it("is gated in release-images.yml before anything is pushed", () => {
    const workflow = readFileSync(
      resolve(REPO_ROOT, ".github/workflows/release-images.yml"),
      "utf8",
    );
    expect(workflow).toContain("spec: apps/mcp-auth-proxy/image.ts");
    expect(workflow).toContain(
      `sbom: ${proxySpec.appRoot}/${proxySpec.bundle.outdir}/${BUNDLE_SBOM}`,
    );
    const smoke = workflow.indexOf("MCP-Auth-Proxy boot smoke");
    expect(smoke).toBeGreaterThan(-1);
    expect(smoke).toBeLessThan(workflow.indexOf("- name: Build + push"));
  });

  it("bundles no database or admin package", async () => {
    const out = mkdtempSync(join(tmpdir(), "service-image-proxy-"));
    try {
      await bundleService(REPO_ROOT, proxySpec, out);
      const sbom = JSON.parse(readFileSync(join(out, BUNDLE_SBOM), "utf8")) as {
        components: Array<{ name: string }>;
      };
      const names = sbom.components.map((c) => c.name);
      expect(names).toContain("zod");
      for (const banned of ["drizzle-orm", "postgres", "pg", "sharp", "deno"]) {
        expect(names).not.toContain(banned);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
