// SPDX-License-Identifier: MPL-2.0

/**
 * #736 — every install runs Pulumi in its own work dir, so two CLI runs for
 * different installs of one provider never read each other's stack config.
 * The last test drives the real `pulumi` CLI (skipped where it is not
 * installed, as in CI): two installs set their config and run `up` at the
 * same time, and each sees only its own.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi/automation";
import { stackWorkDir } from "../install-state.js";
import {
  assertStackProject,
  packageStackDir,
  prepareStackWorkDir,
  workDirProjectFile,
} from "./gcp-pulumi.js";

const STACKS = resolve(import.meta.dir, "../../stacks");
const scratch = mkdtempSync(join(tmpdir(), "caelo-stack-work-dir-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Every file under the package's stacks/ dir with its mtime. */
function packageStacksSnapshot(): Record<string, number> {
  return Object.fromEntries(
    readdirSync(STACKS, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const path = join(e.parentPath, e.name);
        return [path, statSync(path).mtimeMs];
      }),
  );
}

describe("workDirProjectFile", () => {
  it("points main from the work dir at the package's program, keeping the rest", () => {
    const yaml = "name: caelo-gcp\nruntime:\n  name: nodejs\nmain: ./index.ts\ndescription: x\n";
    expect(workDirProjectFile(yaml, "/pkg/stacks/gcp", "/home/o/.caelo-a/stack/gcp")).toBe(
      "name: caelo-gcp\nruntime:\n  name: nodejs\nmain: ../../../../../pkg/stacks/gcp/index.ts\ndescription: x\n",
    );
  });

  it("refuses a project file without exactly one main line", () => {
    expect(() => workDirProjectFile("name: x\n", "/pkg", "/w")).toThrow(/exactly one/);
    expect(() => workDirProjectFile("main: a.ts\nmain: b.ts\n", "/pkg", "/w")).toThrow(/found 2/);
  });
});

describe("prepareStackWorkDir", () => {
  for (const provider of ["gcp", "gcp-firebase"] as const) {
    it(`gives two ${provider} installs separate work dirs and never writes into the package`, () => {
      const before = packageStacksSnapshot();
      const a = prepareStackWorkDir(join(scratch, "a"), provider);
      const b = prepareStackWorkDir(join(scratch, "b"), provider);
      expect(a).toBe(stackWorkDir(join(scratch, "a"), provider));
      expect(a).not.toBe(b);

      // Each install keeps its own settings file; preparing again (a new
      // CLI version) leaves it alone.
      writeFileSync(join(a, "Pulumi.production.yaml"), "config:\n  x:project: a\n");
      writeFileSync(join(b, "Pulumi.production.yaml"), "config:\n  x:project: b\n");
      prepareStackWorkDir(join(scratch, "a"), provider);
      expect(readFileSync(join(a, "Pulumi.production.yaml"), "utf8")).toContain("project: a");
      expect(readFileSync(join(b, "Pulumi.production.yaml"), "utf8")).toContain("project: b");

      const project = readFileSync(join(a, "Pulumi.yaml"), "utf8");
      const main = /^main: (\S+)$/m.exec(project)?.[1] ?? "";
      expect(resolve(realpathSync(a), main)).toBe(
        join(realpathSync(packageStackDir(provider)), "index.ts"),
      );
      expect(packageStacksSnapshot()).toEqual(before);
    });
  }

  it("the package ships no stack settings file (nothing for installs to share)", () => {
    const settings = Object.keys(packageStacksSnapshot()).filter((p) =>
      /Pulumi\.(?!yaml$)[^/]+\.ya?ml$/.test(p),
    );
    expect(settings).toEqual([]);
  });
});

/** A stack whose config holds `project` (or nothing), for the guard. */
function stackWithProject(project: string | undefined): pulumi.Stack {
  const fake: Pick<pulumi.Stack, "getConfig"> & { workspace: Pick<pulumi.Workspace, "workDir"> } = {
    workspace: { workDir: "/home/o/.caelo-a/stack/gcp-firebase" },
    getConfig: async (key) => {
      if (project === undefined) throw new Error(`configuration key '${key}' not found`);
      return { value: project, secret: false };
    },
  };
  return fake as unknown as pulumi.Stack;
}

describe("assertStackProject", () => {
  it("passes when the stack config names the install's project", async () => {
    await assertStackProject(stackWithProject("acme"), "gcp-firebase", "acme");
  });

  it("refuses another install's project, naming both", async () => {
    await expect(
      assertStackProject(stackWithProject("searchviu-website"), "gcp-firebase", "caelo-site"),
    ).rejects.toThrow(/names project searchviu-website, but this install is caelo-site/);
  });

  it("refuses a stack config without a project", async () => {
    await expect(assertStackProject(stackWithProject(undefined), "gcp", "acme")).rejects.toThrow(
      /names project \(none\)/,
    );
  });
});

describe.skipIf(!Bun.which("pulumi"))("two installs at once, real pulumi CLI", () => {
  it("each install's up reads only its own config", async () => {
    // A stand-in for the package's stack program; under the package so node
    // resolves @pulumi/pulumi from it, as the real stacks do.
    const pkg = mkdtempSync(join(import.meta.dir, "../../.stack-work-dir-test-"));
    try {
      const programDir = join(pkg, "stacks", "gcp-firebase");
      mkdirSync(programDir, { recursive: true });
      writeFileSync(
        join(programDir, "Pulumi.yaml"),
        "name: caelo-gcp-firebase\nruntime:\n  name: nodejs\n  options:\n    typescript: true\nmain: ./index.ts\n",
      );
      writeFileSync(
        join(programDir, "index.ts"),
        'import * as pulumi from "@pulumi/pulumi";\nexport const project = new pulumi.Config("caelo-gcp-firebase").require("project");\n',
      );
      writeFileSync(
        join(programDir, "tsconfig.json"),
        readFileSync(join(STACKS, "gcp-firebase", "tsconfig.json")),
      );

      const run = async (install: string, project: string) => {
        const workDir = prepareStackWorkDir(join(scratch, install), "gcp-firebase", programDir);
        const state = join(scratch, install, "state");
        mkdirSync(state, { recursive: true });
        const stack = await pulumi.LocalWorkspace.createOrSelectStack(
          { stackName: "production", workDir },
          {
            envVars: {
              PULUMI_BACKEND_URL: `file://${state}`,
              PULUMI_CONFIG_PASSPHRASE: "test",
              PULUMI_SKIP_UPDATE_CHECK: "true",
            },
          },
        );
        await stack.setConfig("caelo-gcp-firebase:project", { value: project });
        await assertStackProject(stack, "gcp-firebase", project);
        const up = await stack.up();
        return up.outputs.project?.value;
      };

      const [a, b] = await Promise.all([run("real-a", "project-a"), run("real-b", "project-b")]);
      expect([a, b]).toEqual(["project-a", "project-b"]);
      expect(readdirSync(programDir).sort()).toEqual(["Pulumi.yaml", "index.ts", "tsconfig.json"]);
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  }, 180_000);
});
