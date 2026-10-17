// SPDX-License-Identifier: MPL-2.0

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildManifest,
  extractModule,
  findLeaks,
  generateReference,
  jsDocText,
  REFERENCE_SOURCES,
  type ReferenceSource,
  referenceManifestSchema,
  writeReference,
} from "./docs-reference.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const RELEASE = "v9.8.7";

const fixtureRoot = mkdtempSync(join(tmpdir(), "caelo-docs-reference-"));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function fixture(file: string, content: string) {
  const abs = join(fixtureRoot, file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

fixture(
  "packages/demo/src/index.ts",
  `// SPDX-License-Identifier: MPL-2.0

/**
 * Demo SDK.
 *
 * Second paragraph.
 */

import { z } from "zod";

export { z };
export { helper, type Shape } from "./helper.js";
export * from "./star.js";
export type { Foreign } from "@ext/pkg";
export type { Other } from "@ext/pkg";

/** Overloaded greeter. */
export function greet(name: string): string;
export function greet(name: string, loud: boolean): string;
export function greet(name: string, loud = false): string {
  return loud ? name.toUpperCase() : name;
}

/** @internal not for plugin authors */
export const secretHelper = 1;

/** A store. */
export class Store {
  /** Count of items. */
  readonly size: number = 0;
  private hidden = 1;
  #alsoHidden = 2;
  /** Add an item. */
  add(item: string): void {
    this.size;
  }
}

/** Arrow export. */
export const double = (n: number): number => {
  return n * 2;
};
`,
);
fixture(
  "packages/demo/src/helper.ts",
  `/** Helps. */
export function helper(): void {
  // implementation detail
}

/** A shape. */
export interface Shape {
  /** The side. */
  readonly side: number;
}
`,
);
fixture(
  "packages/demo/src/star.ts",
  `/** From a star export. */
export type Starred = "a" | "b";
`,
);
fixture(
  "packages/provisioning/src/cli-routing.ts",
  `export const CLI_COMMANDS = [
  { name: "status", args: "", summary: "Show health." },
  { name: "upgrade", args: "[--version x.y.z]", summary: "Roll forward." },
];
`,
);
fixture("packages/nocli/src/cli-routing.ts", "export const OTHER = 1;\n");
fixture(
  "packages/leaky/src/index.ts",
  "/** Reads /Users/someone/.config before starting. */\nexport const leaky = 1;\n",
);

const DEMO_SOURCES: readonly ReferenceSource[] = [
  {
    slug: "demo",
    title: "Demo reference",
    intro: "Intro used only without file docs.",
    kind: "tsdoc",
    entry: "packages/demo/src/index.ts",
  },
  {
    slug: "cli",
    title: "CLI reference",
    intro: "The CLI.",
    kind: "cli",
    entry: "packages/provisioning/src/cli-routing.ts",
  },
];

describe("jsDocText", () => {
  it("strips the comment syntax and keeps paragraphs", () => {
    expect(jsDocText("/**\n * a\n *\n *   b\n */")).toBe("a\n\n  b");
    expect(jsDocText("/** one line */")).toBe("one line");
  });
});

describe("extractModule", () => {
  const mod = extractModule(fixtureRoot, "packages/demo/src/index.ts");
  const byName = new Map(mod.symbols.map((s) => [s.name, s]));

  it("reads the file-level doc", () => {
    expect(mod.fileDoc).toBe("Demo SDK.\n\nSecond paragraph.");
  });

  it("lists exports in export order, following relative and star re-exports", () => {
    expect(mod.symbols.map((s) => s.name)).toEqual([
      "helper",
      "Shape",
      "Starred",
      "greet",
      "Store",
      "double",
    ]);
    expect(byName.get("helper")?.file).toBe("packages/demo/src/helper.ts");
    expect(byName.get("Shape")?.code).toContain("/** The side. */");
  });

  it("leaves out @internal symbols", () => {
    expect(byName.has("secretHelper")).toBe(false);
  });

  it("shows signatures, not implementations", () => {
    expect(byName.get("helper")?.code).toBe("export function helper(): void { … }");
    expect(byName.get("helper")?.code).not.toContain("implementation detail");
    const greet = byName.get("greet")?.code ?? "";
    expect(greet.split("\n")).toHaveLength(3);
    expect(greet).not.toContain("toUpperCase");
    expect(byName.get("double")?.code).toBe("export const double = (n: number): number => { … };");
  });

  it("hides private class members and initialisers", () => {
    const store = byName.get("Store")?.code ?? "";
    expect(store).toContain("readonly size: number;");
    expect(store).toContain("add(item: string): void { … }");
    expect(store).toContain("/** Add an item. */");
    expect(store).not.toContain("hidden");
    expect(store).not.toContain("this.size");
  });

  it("records the declaration line (after the doc comment) for source links", () => {
    expect(byName.get("helper")?.line).toBe(2);
  });

  it("merges re-exports from other packages per package", () => {
    expect(mod.foreign).toEqual([
      { from: "zod", names: ["z"] },
      { from: "@ext/pkg", names: ["Foreign", "Other"] },
    ]);
  });
});

describe("generateReference (fixture)", () => {
  it("renders repo-owned pages linking to the release tag", async () => {
    const pages = await generateReference(fixtureRoot, RELEASE, DEMO_SOURCES);
    expect(pages.map((p) => p.path)).toEqual([
      "/docs/reference/",
      "/docs/reference/demo/",
      "/docs/reference/cli/",
    ]);
    const demo = pages[1]?.markdown ?? "";
    expect(demo).toContain("owner: repo");
    expect(demo).toContain(`release: ${RELEASE}`);
    expect(demo).toContain("Do not edit this page in the CMS");
    expect(demo).toContain(
      `https://github.com/caelo-cms/caelo-cms/blob/${RELEASE}/packages/demo/src/helper.ts#L2`,
    );
    expect(demo).toContain("Demo SDK.");
    expect(demo).not.toContain("Intro used only without file docs.");
    const cli = pages[2]?.markdown ?? "";
    expect(cli).toContain("cms-provision upgrade [--version x.y.z]");
    expect(cli).toContain("Roll forward.");
    expect(pages[0]?.markdown).toContain("- [Demo reference](/docs/reference/demo/)");
  });

  it("refuses a CLI source without the catalogue", async () => {
    const src: ReferenceSource = {
      ...(DEMO_SOURCES[1] as ReferenceSource),
      entry: "packages/nocli/src/cli-routing.ts",
    };
    await expect(generateReference(fixtureRoot, RELEASE, [src])).rejects.toThrow(/CLI_COMMANDS/);
  });

  it("refuses to render a page that leaks a local path", async () => {
    const src: ReferenceSource = {
      slug: "leaky",
      title: "Leaky",
      intro: "x",
      kind: "tsdoc",
      entry: "packages/leaky/src/index.ts",
    };
    await expect(generateReference(fixtureRoot, RELEASE, [src])).rejects.toThrow(
      /local home-directory path/,
    );
  });

  it("refuses something that is not a release tag", async () => {
    await expect(generateReference(fixtureRoot, "main", DEMO_SOURCES)).rejects.toThrow(
      /release tag/,
    );
  });
});

describe("generateReference (this repository)", () => {
  it("is byte-identical across runs and clean of leaks", async () => {
    const a = await generateReference(REPO_ROOT, RELEASE);
    const b = await generateReference(REPO_ROOT, RELEASE);
    expect(a).toEqual(b);
    expect(a.map((p) => p.slug)).toEqual(["index", ...REFERENCE_SOURCES.map((s) => s.slug)]);
    for (const p of a) {
      expect(findLeaks(p.markdown)).toEqual([]);
      expect(p.markdown).toContain("owner: repo");
      expect(p.path.startsWith("/docs/reference/")).toBe(true);
      for (const url of p.markdown.match(/https:\/\/github\.com\/caelo-cms\/caelo-cms\/\S+/g) ??
        []) {
        expect(url).toMatch(new RegExp(`/(blob|tree)/${RELEASE.replace(/\./g, "\\.")}(/|\\b)`));
      }
    }
    const sdk = a.find((p) => p.slug === "plugin-sdk")?.markdown ?? "";
    expect(sdk).toContain("## `definePlugin`");
    const query = a.find((p) => p.slug === "query-api")?.markdown ?? "";
    expect(query).toContain("## `execute`");
    expect(query).toContain("## `defineOperation`");
    const cli = a.find((p) => p.slug === "provisioning-cli")?.markdown ?? "";
    expect(cli).toContain("## `upgrade`");
  });

  it("writes pages plus a manifest whose hashes match", async () => {
    const pages = await generateReference(REPO_ROOT, RELEASE);
    const out = join(fixtureRoot, "out");
    writeReference(out, RELEASE, pages);
    const manifest = referenceManifestSchema.parse(
      JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")),
    );
    expect(manifest).toEqual(buildManifest(RELEASE, pages));
    for (const entry of manifest.pages) {
      const md = readFileSync(join(out, entry.file), "utf8");
      expect(md).toBe(pages.find((p) => p.slug === entry.slug)?.markdown ?? "");
      const hash = new Bun.CryptoHasher("sha256").update(md).digest("hex");
      expect(hash).toBe(entry.sha256);
    }
  });
});

describe("findLeaks", () => {
  it("flags secret-shaped strings and local paths", () => {
    const samples: Array<[string, string]> = [
      ["see /home/runner/work/x", "local home-directory path"],
      ["C:\\Users\\me\\x", "local home-directory path"],
      ["~/.caelo-abc123/secrets", "operator secrets directory"],
      ["[x](docs/internal/e2e.md)", "docs/internal/"],
      [`key sk-ant-${"a".repeat(30)}`, "Anthropic API key"],
      [`ghp_${"A".repeat(36)}`, "GitHub token"],
      ["AKIAABCDEFGHIJKLMNOP", "AWS access key id"],
      ["-----BEGIN RSA PRIVATE KEY-----", "private key"],
      ["postgres://user:pa55@db:5432/x", "database URL with a password"],
    ];
    for (const [text, what] of samples) {
      expect(findLeaks(text).join(" ")).toContain(what);
    }
  });

  it("accepts ordinary reference text", () => {
    expect(
      findLeaks(
        "Connect with `postgres://host/db` and read `packages/query-api/src/adapter.ts`; the token lives in `x-caelo-mcp-token`.",
      ),
    ).toEqual([]);
  });
});
