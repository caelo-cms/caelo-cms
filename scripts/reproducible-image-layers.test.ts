// SPDX-License-Identifier: MPL-2.0

/**
 * #1559 contract over `apps/admin/Dockerfile` and
 * `packages/provisioning/Dockerfile.ops`: the dependency trees reach the
 * runtime images as reproducible layers.
 *
 * Every release used to re-upload the admin image's two node_modules layers
 * (about 310 MB compressed) and the ops image's (about 35 MB per
 * architecture), although their content was the same unless bun.lock
 * changed: a fresh install dates every file anew, and a plain
 * `COPY --from=builder /repo/node_modules ./node_modules` also dates the
 * `/app` entry it adds to. Releases are kept in the registry for good, so
 * that was most of its growth. Now each tree is staged in the builder under
 * a root that holds its whole path, with one fixed timestamp on every entry,
 * and copied with `COPY --link`: the same dependencies give the same layer.
 *
 * D1 the admin runtime stage takes node_modules only from the staging roots
 *    (plus Playwright for the Chromium install and SvelteKit's `$app` types);
 * D2 the admin builder stages both trees before the source is copied, so the
 *    step re-runs only when the manifests or bun.lock change;
 * D3 the `$app` copy escapes the `$`, which would otherwise expand to an
 *    empty build variable and copy the whole tree;
 * O1 the ops tree is staged the same way and linked before the CLI's files;
 * T1 both images use the same fixed timestamp;
 * C1 in release-images.yml only the push build writes the gha cache scope:
 *    a scope keeps only its last export, and the amd64-only smoke build's
 *    export used to wipe the push build's arm64 half, so every ops build
 *    rebuilt arm64 and every release carried ~334 MB of new arm64 layers.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const ROOT = resolve(import.meta.dir, "..");

interface Instruction {
  readonly stage: string;
  readonly text: string;
}

/**
 * The instructions of a Dockerfile, comments dropped and continuation lines
 * joined, each with the stage (`AS <name>`, or its index) it belongs to.
 */
function instructions(path: string): Instruction[] {
  const lines = readFileSync(resolve(ROOT, path), "utf8").split("\n");
  const out: Instruction[] = [];
  let stage = "";
  let stages = 0;
  let pending = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (pending === "" && (line === "" || line.startsWith("#"))) continue;
    if (line.startsWith("#")) continue;
    const continued = line.endsWith(" \\") || line === "\\";
    pending += `${continued ? line.slice(0, -1) : line} `;
    if (continued) continue;
    const text = pending.trim().replace(/\s+/g, " ");
    pending = "";
    if (/^FROM\s/i.test(text)) {
      stage = text.match(/\sAS\s+(\S+)$/i)?.[1] ?? String(stages);
      stages++;
    }
    out.push({ stage, text });
  }
  return out;
}

const STAGING_TOUCH = /find \/deps -exec touch -h -d @(\d+) \{\} \+/;

describe("apps/admin/Dockerfile — reproducible dependency layers (#1559)", () => {
  const all = instructions("apps/admin/Dockerfile");
  const runtime = all.filter((i) => i.stage === "runtime");
  const builder = all.filter((i) => i.stage === "builder");

  it("D1: the runtime stage takes node_modules only from the staging roots", () => {
    expect(runtime.map((i) => i.text)).toContain("COPY --link --from=builder /deps/root/ /");
    expect(runtime.map((i) => i.text)).toContain("COPY --link --from=builder /deps/admin/ /");
    const nodeModulesCopies = runtime
      .filter((i) => /^COPY\s/.test(i.text) && i.text.includes("node_modules"))
      .map((i) => i.text);
    expect(nodeModulesCopies).toEqual([
      "COPY --from=builder /repo/node_modules/playwright /tmp/pw/node_modules/playwright",
      "COPY --from=builder /repo/apps/admin/node_modules/\\$app ./apps/admin/node_modules/\\$app",
    ]);
  });

  it("D2: both trees are staged with one timestamp, after the shim and before the source", () => {
    const at = (re: RegExp) => builder.findIndex((i) => re.test(i.text));
    const stage = at(STAGING_TOUCH);
    const staged = builder[stage]?.text ?? "";
    expect(staged).toContain("cp -a /repo/node_modules /deps/root/app/node_modules");
    expect(staged).toContain(
      "cp -a /repo/apps/admin/node_modules /deps/admin/app/apps/admin/node_modules",
    );
    expect(stage).toBeGreaterThan(at(/^RUN bun install$/));
    expect(stage).toBeGreaterThan(at(/xargs -a \/tmp\/native-list npm install/));
    expect(stage).toBeGreaterThan(at(/> \/repo\/node_modules\/bun\/index\.js/));
    expect(stage).toBeLessThan(at(/^COPY \. \.$/));
  });

  it("D3: the `$app` copy names the directory, not an empty build variable", () => {
    const copy = runtime.find((i) => i.text.includes("node_modules/\\$app"));
    expect(copy?.text).toMatch(/\/repo\/apps\/admin\/node_modules\/\\\$app /);
    expect(runtime.some((i) => /node_modules\/\$app/.test(i.text))).toBe(false);
  });
});

describe("packages/provisioning/Dockerfile.ops — reproducible dependency layer (#1559)", () => {
  const all = instructions("packages/provisioning/Dockerfile.ops");
  const runtime = all.filter((i) => i.stage === "runtime").map((i) => i.text);
  const builder = all.filter((i) => i.stage === "builder").map((i) => i.text);

  it("O1: node_modules is staged on its own and linked before the CLI's files", () => {
    const assemble = builder.find((t) => t.includes("/opt/caelo-ops")) ?? "";
    expect(assemble).toContain("cp -a node_modules /deps/opt/caelo-ops/");
    expect(assemble).toMatch(STAGING_TOUCH);
    expect(assemble).not.toContain("cp -a node_modules /opt/caelo-ops/");
    const link = runtime.indexOf("COPY --link --from=builder /deps/ /");
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(runtime.indexOf("COPY --from=builder /opt/caelo-ops /opt/caelo-ops"));
  });
});

describe("release-images.yml — one cache writer per scope (#1559)", () => {
  interface Step {
    readonly name?: string;
    readonly uses?: string;
    readonly with?: Record<string, unknown>;
  }
  const workflow = yaml.load(
    readFileSync(resolve(ROOT, ".github/workflows/release-images.yml"), "utf8"),
  ) as { jobs: { build: { steps: readonly Step[] } } };
  const builds = workflow.jobs.build.steps.filter((s) =>
    s.uses?.startsWith("docker/build-push-action"),
  );

  it("C1: every build reads the scope, and only the push build writes it", () => {
    expect(builds.length).toBeGreaterThan(1);
    for (const step of builds) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
      expect(step.with?.["cache-from"]).toBe("type=gha,scope=${{ matrix.service }}");
    }
    const writers = builds.filter((s) => s.with?.["cache-to"] !== undefined).map((s) => s.name);
    expect(writers).toEqual(["Build + push"]);
  });
});

describe("one fixed timestamp (#1559)", () => {
  it("T1: both images stage their trees at the same time", () => {
    const timeOf = (path: string) =>
      instructions(path)
        .map((i) => STAGING_TOUCH.exec(i.text)?.[1])
        .filter((t): t is string => t !== undefined);
    const admin = timeOf("apps/admin/Dockerfile");
    const ops = timeOf("packages/provisioning/Dockerfile.ops");
    expect(admin).toHaveLength(1);
    expect(ops).toEqual(admin);
  });
});
