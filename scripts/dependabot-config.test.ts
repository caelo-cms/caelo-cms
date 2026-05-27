// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #25 regression contract over `.github/dependabot.yml`.
 *
 * The Dependabot config is a single file GitHub parses server-side and
 * acts on autonomously. A typo, a dropped field, or a renamed ecosystem
 * would silently break the auto-update loop in ways that only surface
 * weeks later when a PR fails to arrive. This test locks every
 * load-bearing field so a regression fires locally before merge.
 *
 * Each assertion below names the invariant from `.workflow-plan.md`'s
 * Scope or AC coverage that would fire if the field were removed.
 *
 * S1: SPDX header is the file's first non-blank line (CLAUDE.md §5).
 * S2: `version: 2` (Dependabot's required schema version).
 * S3: three `updates` entries — one per ecosystem.
 * S4: bun block uses workspace globs matching root package.json
 *     `workspaces` plus `/claude-workflow` explicitly. A new workspace
 *     added to `package.json` without updating Dependabot would fall
 *     through this assertion.
 * S5: every ecosystem block carries `schedule.interval: weekly`,
 *     `schedule.day: monday` (AC #2 — first PR within 7 days).
 * S6: every block carries `labels: ["dependencies"]` so the AC #3
 *     security PR is filterable on arrival.
 * S7: every block carries `commit-message.prefix: "chore(deps)"` so
 *     PR titles match Conventional Commits (CLAUDE.md §9).
 * S8: bun block carries `versioning-strategy: "increase"` (Risk §7 —
 *     `lockfile-only` would silently produce zero PRs in this repo).
 * S9: every block carries `rebase-strategy: "auto"` so PRs stay
 *     mergeable as `main` advances.
 * S10: every block carries `open-pull-requests-limit: 10` so the
 *     first weekly run can't open all 22+ workspace PRs at once.
 * S11: every block carries a `minor-and-patch` group with
 *     `update-types: ["minor", "patch"]` (issue #25 scope).
 * S12: every block carries `cooldown.default-days: 3` so brand-new
 *     releases don't reach the queue.
 * S13: negative assertions — no `registries`, no `allow`, no
 *     `reviewers`, no `assignees` (the deferred-scope decisions from
 *     plan §3 / Risk §6).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = join(import.meta.dir, "..");
const CONFIG_PATH = join(REPO_ROOT, ".github", "dependabot.yml");
const RAW = readFileSync(CONFIG_PATH, "utf8");

type CommitMessage = {
  prefix?: string;
  "prefix-development"?: string;
};

type ScheduleBlock = {
  interval?: string;
  day?: string;
  time?: string;
  timezone?: string;
};

type GroupBlock = {
  "update-types"?: ReadonlyArray<string>;
};

type CooldownBlock = {
  "default-days"?: number;
};

type UpdateEntry = {
  "package-ecosystem"?: string;
  directory?: string;
  directories?: ReadonlyArray<string>;
  schedule?: ScheduleBlock;
  labels?: ReadonlyArray<string>;
  "commit-message"?: CommitMessage;
  "versioning-strategy"?: string;
  "rebase-strategy"?: string;
  "open-pull-requests-limit"?: number;
  cooldown?: CooldownBlock;
  groups?: Record<string, GroupBlock>;
  registries?: unknown;
  allow?: unknown;
  reviewers?: unknown;
  assignees?: unknown;
};

type DependabotConfig = {
  version?: number;
  updates?: ReadonlyArray<UpdateEntry>;
};

const parsed = yaml.load(RAW) as DependabotConfig;

const updates = parsed.updates ?? [];
const bunEntry = updates.find((u) => u["package-ecosystem"] === "bun");
const actionsEntry = updates.find(
  (u) => u["package-ecosystem"] === "github-actions",
);
const dockerEntry = updates.find((u) => u["package-ecosystem"] === "docker");

const rootPkg = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
) as { workspaces?: ReadonlyArray<string> };

describe("S1: SPDX header", () => {
  it("first non-blank line is the MPL-2.0 SPDX marker", () => {
    const firstNonBlank = RAW.split("\n").find((l) => l.trim().length > 0);
    expect(firstNonBlank).toBe("# SPDX-License-Identifier: MPL-2.0");
  });
});

describe("S2 + S3: schema version + entry count", () => {
  it("version is 2", () => {
    expect(parsed.version).toBe(2);
  });

  it("has exactly three update entries", () => {
    expect(updates).toHaveLength(3);
  });

  it("covers bun, github-actions, and docker", () => {
    expect(bunEntry).toBeDefined();
    expect(actionsEntry).toBeDefined();
    expect(dockerEntry).toBeDefined();
  });
});

describe("S4: bun block directories mirror root workspaces + claude-workflow", () => {
  it("uses globs matching root package.json `workspaces`", () => {
    const expected = new Set<string>(["/"]);
    for (const glob of rootPkg.workspaces ?? []) {
      expected.add(`/${glob}`);
    }
    expected.add("/claude-workflow");

    const actual = new Set(bunEntry?.directories ?? []);
    expect(actual).toEqual(expected);
  });
});

describe("S5: weekly Monday schedule on every block", () => {
  it.each([
    ["bun", bunEntry],
    ["github-actions", actionsEntry],
    ["docker", dockerEntry],
  ])("%s: interval weekly, day monday", (_ecosystem, entry) => {
    expect(entry?.schedule?.interval).toBe("weekly");
    expect(entry?.schedule?.day).toBe("monday");
  });
});

describe("S6: dependencies label on every block", () => {
  it.each([
    ["bun", bunEntry],
    ["github-actions", actionsEntry],
    ["docker", dockerEntry],
  ])("%s: labels === ['dependencies']", (_ecosystem, entry) => {
    expect(entry?.labels).toEqual(["dependencies"]);
  });
});

describe("S7: Conventional Commits commit-message prefix", () => {
  it.each([
    ["bun", bunEntry],
    ["github-actions", actionsEntry],
    ["docker", dockerEntry],
  ])("%s: prefix is `chore(deps)`", (_ecosystem, entry) => {
    expect(entry?.["commit-message"]?.prefix).toBe("chore(deps)");
  });

  it("bun block carries `chore(deps-dev)` for devDependencies", () => {
    expect(bunEntry?.["commit-message"]?.["prefix-development"]).toBe(
      "chore(deps-dev)",
    );
  });
});

describe("S8: bun block uses versioning-strategy `increase`", () => {
  it("not `lockfile-only` (would be a no-op against exact pins)", () => {
    expect(bunEntry?.["versioning-strategy"]).toBe("increase");
  });
});

describe("S9: rebase-strategy `auto` on every block", () => {
  it.each([
    ["bun", bunEntry],
    ["github-actions", actionsEntry],
    ["docker", dockerEntry],
  ])("%s: rebase-strategy auto", (_ecosystem, entry) => {
    expect(entry?.["rebase-strategy"]).toBe("auto");
  });
});

describe("S10: open-pull-requests-limit 10 on every block", () => {
  it.each([
    ["bun", bunEntry],
    ["github-actions", actionsEntry],
    ["docker", dockerEntry],
  ])("%s: cap is 10", (_ecosystem, entry) => {
    expect(entry?.["open-pull-requests-limit"]).toBe(10);
  });
});

describe("S11: minor-and-patch group on every block", () => {
  it.each([
    ["bun", bunEntry],
    ["github-actions", actionsEntry],
    ["docker", dockerEntry],
  ])(
    "%s: groups.minor-and-patch update-types === ['minor', 'patch']",
    (_ecosystem, entry) => {
      const group = entry?.groups?.["minor-and-patch"];
      expect(group).toBeDefined();
      expect(group?.["update-types"]).toEqual(["minor", "patch"]);
    },
  );
});

describe("S12: cooldown default-days 3 on every block", () => {
  it.each([
    ["bun", bunEntry],
    ["github-actions", actionsEntry],
    ["docker", dockerEntry],
  ])("%s: cooldown.default-days is 3", (_ecosystem, entry) => {
    expect(entry?.cooldown?.["default-days"]).toBe(3);
  });
});

describe("S13: deferred-scope keys stay absent", () => {
  it.each([
    ["bun", bunEntry],
    ["github-actions", actionsEntry],
    ["docker", dockerEntry],
  ])(
    "%s: no registries / allow / reviewers / assignees keys",
    (_ecosystem, entry) => {
      expect(entry?.registries).toBeUndefined();
      expect(entry?.allow).toBeUndefined();
      expect(entry?.reviewers).toBeUndefined();
      expect(entry?.assignees).toBeUndefined();
    },
  );
});

describe("docker block covers the right paths", () => {
  it("includes both Dockerfile dirs plus the root compose file", () => {
    const dirs = new Set(dockerEntry?.directories ?? []);
    expect(dirs).toEqual(
      new Set(["/apps/admin", "/apps/api-gateway", "/"]),
    );
  });
});

describe("github-actions block points at repo root", () => {
  it("directory is /", () => {
    expect(actionsEntry?.directory).toBe("/");
  });
});
