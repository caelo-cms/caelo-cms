// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type AutoUpdateInput,
  decideAutoUpdate,
  isPausedAt,
  isSecurityRelease,
  nextWindowOpening,
  type ReleaseFacts,
} from "./auto-update.js";
import type { StoredUpdatePolicy } from "./platform-updates.js";

const NOW = new Date("2026-10-14T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const POLICY: StoredUpdatePolicy = {
  mode: "auto",
  autoSecurity: true,
  autoPatch: true,
  autoMinor: false,
  channel: "stable",
  windowStart: null,
  windowEnd: null,
  windowTimezone: "UTC",
  soakHours: 24,
  securitySoakHours: 2,
  paused: false,
  pausedReason: null,
  pausedAt: null,
  pausedUntil: null,
  pausedByOwner: false,
  updatedAt: "2026-10-01T00:00:00Z",
};

const FACTS: ReleaseFacts = {
  security: false,
  advisories: [],
  contractMigrations: false,
  infraChange: false,
};
const SECURITY: ReleaseFacts = {
  ...FACTS,
  security: true,
  advisories: ["GHSA-abcd-efgh-jkmp"],
};

const INSTALLED = "0.10.47";
const VERSIONS = { patch: "0.10.48", minor: "0.11.0", major: "1.0.0" } as const;

function input(over: Partial<AutoUpdateInput> & { version?: string; publishedHoursAgo?: number }) {
  const { version = VERSIONS.patch, publishedHoursAgo = 48, ...rest } = over;
  return {
    policy: POLICY,
    installedVersion: INSTALLED,
    release: { version, publishedAt: hoursAgo(publishedHoursAgo) },
    facts: FACTS,
    upgraderAvailable: true,
    now: NOW,
    ...rest,
  } satisfies AutoUpdateInput;
}

describe("decideAutoUpdate — release type × policy toggles", () => {
  type Kind = keyof typeof VERSIONS;
  const cases: [Kind, boolean, Partial<StoredUpdatePolicy>, string, string | null][] = [
    // [type, security, policy toggles, expected action, expected basis]
    ["patch", false, { autoPatch: true }, "install", "patch"],
    ["patch", false, { autoPatch: false, autoSecurity: true }, "notify", null],
    ["minor", false, { autoMinor: true }, "install", "minor"],
    ["minor", false, { autoMinor: false, autoPatch: true }, "notify", null],
    ["patch", true, { autoSecurity: true, autoPatch: false }, "install", "security"],
    ["minor", true, { autoSecurity: true, autoMinor: false }, "install", "security"],
    ["patch", true, { autoSecurity: false, autoPatch: true }, "install", "patch"],
    ["minor", true, { autoSecurity: false, autoMinor: false }, "notify", null],
    // Major never installs automatically, whatever is switched on.
    ["major", false, { autoPatch: true, autoMinor: true, autoSecurity: true }, "notify", null],
    ["major", true, { autoPatch: true, autoMinor: true, autoSecurity: true }, "notify", null],
  ];
  it.each(cases)("%s (security=%s) %o → %s", (kind, security, toggles, action, basis) => {
    const d = decideAutoUpdate(
      input({
        version: VERSIONS[kind],
        policy: { ...POLICY, ...toggles },
        facts: security ? SECURITY : FACTS,
      }),
    );
    expect(d.action).toBe(action);
    expect("basis" in d ? d.basis : null).toBe(basis);
  });
});

describe("decideAutoUpdate — security flag needs a published advisory", () => {
  it("a manifest saying security without a GHSA is a normal release", () => {
    const facts = { ...FACTS, security: isSecurityRelease({ security: true, advisories: [] }) };
    const d = decideAutoUpdate(
      input({ policy: { ...POLICY, autoPatch: false }, facts, publishedHoursAgo: 3 }),
    );
    expect(d.action).toBe("notify");
  });
  it("isSecurityRelease", () => {
    expect(isSecurityRelease({ security: true, advisories: ["GHSA-abcd-efgh-jkmp"] })).toBe(true);
    expect(isSecurityRelease({ security: true, advisories: [] })).toBe(false);
    expect(isSecurityRelease({ security: false, advisories: ["GHSA-abcd-efgh-jkmp"] })).toBe(false);
  });
});

describe("decideAutoUpdate — soak period", () => {
  const cases: [string, ReleaseFacts, Partial<StoredUpdatePolicy>, number, string][] = [
    ["patch inside the 24 h soak", FACTS, {}, 23, "wait"],
    ["patch after the 24 h soak", FACTS, {}, 25, "install"],
    ["security inside its 2 h soak", SECURITY, {}, 1, "wait"],
    ["security after its 2 h soak", SECURITY, {}, 3, "install"],
    ["security with zero soak", SECURITY, { securitySoakHours: 0 }, 0, "install"],
    // Security soak only applies when the release installs AS a security fix.
    [
      "security installed as patch keeps the patch soak",
      SECURITY,
      { autoSecurity: false },
      3,
      "wait",
    ],
    ["zero soak installs at once", FACTS, { soakHours: 0, securitySoakHours: 0 }, 0, "install"],
  ];
  it.each(cases)("%s", (_name, facts, policy, publishedHoursAgo, action) => {
    const d = decideAutoUpdate(
      input({ facts, policy: { ...POLICY, ...policy }, publishedHoursAgo }),
    );
    expect(d.action).toBe(action);
  });

  it("names when the wait ends", () => {
    const d = decideAutoUpdate(input({ publishedHoursAgo: 20 }));
    expect(d.action).toBe("wait");
    if (d.action !== "wait") return;
    expect(d.until?.toISOString()).toBe(new Date(NOW.getTime() + 4 * 3_600_000).toISOString());
    expect(d.paused).toBe(false);
  });

  it("a release without a publish date is blocked, not guessed", () => {
    const d = decideAutoUpdate({
      ...input({}),
      release: { version: VERSIONS.patch, publishedAt: null },
    });
    expect(d.action).toBe("blocked");
    expect(d.reason).toContain("publish date");
  });
});

describe("decideAutoUpdate — maintenance window", () => {
  // NOW is 12:00 UTC = 14:00 in Berlin (CEST).
  const cases: [string, Partial<StoredUpdatePolicy>, string][] = [
    [
      "inside a daytime window",
      { windowStart: "13:00", windowEnd: "15:00", windowTimezone: "Europe/Berlin" },
      "install",
    ],
    [
      "outside a night window",
      { windowStart: "02:00", windowEnd: "05:00", windowTimezone: "Europe/Berlin" },
      "wait",
    ],
    [
      "inside a window spanning midnight (UTC)",
      { windowStart: "11:00", windowEnd: "01:00" },
      "install",
    ],
    ["no window = any time", {}, "install"],
  ];
  it.each(cases)("%s", (_name, policy, action) => {
    expect(decideAutoUpdate(input({ policy: { ...POLICY, ...policy } })).action).toBe(action);
  });

  it("waits until the window opens", () => {
    const d = decideAutoUpdate(
      input({
        policy: {
          ...POLICY,
          windowStart: "02:00",
          windowEnd: "05:00",
          windowTimezone: "Europe/Berlin",
        },
      }),
    );
    expect(d.action === "wait" && d.until?.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });

  it("soak ending outside the window waits for the next opening", () => {
    const d = decideAutoUpdate(
      input({
        publishedHoursAgo: 23, // soak ends 13:00 UTC
        policy: { ...POLICY, windowStart: "20:00", windowEnd: "22:00" },
      }),
    );
    expect(d.action === "wait" && d.until?.toISOString()).toBe("2026-10-14T20:00:00.000Z");
  });
});

describe("decideAutoUpdate — pause", () => {
  const cases: [string, Partial<StoredUpdatePolicy>, string, boolean][] = [
    [
      "paused indefinitely by the Owner",
      { paused: true, pausedAt: hoursAgo(1), pausedByOwner: true },
      "wait",
      true,
    ],
    [
      "paused after a failure",
      { paused: true, pausedAt: hoursAgo(1), pausedReason: "rolled back" },
      "wait",
      true,
    ],
    [
      "paused until tomorrow",
      {
        paused: true,
        pausedAt: hoursAgo(1),
        pausedByOwner: true,
        pausedUntil: "2026-10-15T00:00:00Z",
      },
      "wait",
      true,
    ],
    [
      "pause already over",
      { paused: true, pausedAt: hoursAgo(30), pausedByOwner: true, pausedUntil: hoursAgo(1) },
      "install",
      false,
    ],
  ];
  it.each(cases)("%s", (_name, policy, action, paused) => {
    const d = decideAutoUpdate(input({ policy: { ...POLICY, ...policy } }));
    expect(d.action).toBe(action);
    if (d.action === "wait") expect(d.paused).toBe(paused);
  });

  it("isPausedAt", () => {
    expect(isPausedAt({ paused: false, pausedUntil: null }, NOW)).toBe(false);
    expect(isPausedAt({ paused: true, pausedUntil: null }, NOW)).toBe(true);
    expect(isPausedAt({ paused: true, pausedUntil: hoursAgo(-1) }, NOW)).toBe(true);
    expect(isPausedAt({ paused: true, pausedUntil: hoursAgo(1) }, NOW)).toBe(false);
  });
});

describe("decideAutoUpdate — releases that never install automatically", () => {
  const cases: [string, Partial<AutoUpdateInput>, string][] = [
    ["infra change", { facts: { ...FACTS, infraChange: true } }, "needs_cloud_shell"],
    [
      "infra change on a security fix",
      { facts: { ...SECURITY, infraChange: true } },
      "needs_cloud_shell",
    ],
    ["destructive migrations", { facts: { ...FACTS, contractMigrations: true } }, "manual"],
    ["destructive security fix", { facts: { ...SECURITY, contractMigrations: true } }, "manual"],
    ["manifest unreadable", { facts: { unavailable: "HTTP 404" } }, "blocked"],
    ["no upgrader", { upgraderAvailable: false }, "blocked"],
  ];
  it.each(cases)("%s → %s", (_name, over, action) => {
    expect(decideAutoUpdate({ ...input({}), ...over }).action).toBe(action);
  });

  it("infra unknown here is left to the upgrader (it checks install.json)", () => {
    expect(decideAutoUpdate(input({ facts: { ...FACTS, infraChange: null } })).action).toBe(
      "install",
    );
  });

  it("an infra-changing major is still just a major (notify)", () => {
    const d = decideAutoUpdate(
      input({ version: VERSIONS.major, facts: { ...FACTS, infraChange: true } }),
    );
    expect(d.action).toBe("notify");
  });
});

describe("decideAutoUpdate — upgrader not ready", () => {
  it("names why the upgrader cannot take the release (e.g. the self-hosted agent)", () => {
    const d = decideAutoUpdate({
      ...input({}),
      upgraderAvailable: false,
      upgraderProblem: "The update agent on box-1 has not checked in since 10:00.",
    });
    expect(d.action).toBe("blocked");
    expect(d.reason).toContain("has not checked in");
  });
});

describe("decideAutoUpdate — modes and versions", () => {
  it.each([
    ["up to date", { version: INSTALLED }, "none"],
    ["older release", { version: "0.10.40" }, "none"],
    ["notices off", { policy: { ...POLICY, mode: "off" as const } }, "none"],
    ["notify mode", { policy: { ...POLICY, mode: "notify" as const } }, "notify"],
    [
      "notify mode, infra change",
      { policy: { ...POLICY, mode: "notify" as const }, facts: { ...FACTS, infraChange: true } },
      "notify",
    ],
    ["pre-release", { version: "0.11.0-rc.1" }, "notify"],
  ] as const)("%s → %s", (_name, over, action) => {
    expect(decideAutoUpdate(input(over as Parameters<typeof input>[0])).action).toBe(action);
  });

  it("no release known yet → none", () => {
    expect(decideAutoUpdate({ ...input({}), release: null }).action).toBe("none");
  });
});

describe("nextWindowOpening", () => {
  it("returns the start of the next window in the window's time zone", () => {
    const p = { windowStart: "02:00", windowEnd: "05:00", windowTimezone: "America/New_York" };
    // 12:00 UTC = 08:00 New York (EDT) → next 02:00 New York = 06:00 UTC tomorrow.
    expect(nextWindowOpening(p, NOW)?.toISOString()).toBe("2026-10-15T06:00:00.000Z");
  });
  it("is `from` itself (rounded up to the minute) inside the window", () => {
    const p = { windowStart: "11:00", windowEnd: "13:00", windowTimezone: "UTC" };
    expect(nextWindowOpening(p, new Date("2026-10-14T12:00:30Z"))?.toISOString()).toBe(
      "2026-10-14T12:01:00.000Z",
    );
  });
});
