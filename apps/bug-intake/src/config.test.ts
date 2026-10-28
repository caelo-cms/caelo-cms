// SPDX-License-Identifier: MPL-2.0

/**
 * #980 — the intake refuses to start on incomplete configuration and names
 * the variable, and the issue limits (daily cap, kill switch, global
 * registration limit) are parsed strictly: a typo in the kill switch must
 * not leave it in an unknown state.
 */

import { describe, expect, it } from "bun:test";
import { loadIntakeEnv } from "./config.js";

const complete = {
  PORT: "8080",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
  GITHUB_APP_INSTALLATION_ID: "678",
  BUG_INTAKE_PUBLIC_REPO: "caelo-cms/caelo-cms",
  BUG_INTAKE_FIRESTORE_PROJECT: "caelo-website",
  BUG_INTAKE_FIRESTORE_DATABASE: "bug-intake",
  BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS: "1",
  BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY: "20",
  BUG_INTAKE_MAX_NEW_SUGGESTIONS_PER_DAY: "5",
  BUG_INTAKE_ISSUES_PAUSED: "false",
  BUG_INTAKE_MAX_REGISTRATIONS_PER_HOUR: "200",
  ANTHROPIC_API_KEY: "sk-test",
  BUG_INTAKE_MATCH_MODEL: "claude-haiku-5-5",
};

describe("bug intake configuration", () => {
  it("parses a complete environment", () => {
    expect(loadIntakeEnv(complete)).toMatchObject({
      PORT: 8080,
      BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS: 1,
      BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY: 20,
      BUG_INTAKE_MAX_NEW_SUGGESTIONS_PER_DAY: 5,
      BUG_INTAKE_ISSUES_PAUSED: false,
      BUG_INTAKE_MAX_REGISTRATIONS_PER_HOUR: 200,
      BUG_INTAKE_FIRESTORE_DATABASE: "bug-intake",
    });
    expect(loadIntakeEnv({ ...complete, BUG_INTAKE_ISSUES_PAUSED: "true" })).toMatchObject({
      BUG_INTAKE_ISSUES_PAUSED: true,
    });
    expect(
      loadIntakeEnv({ ...complete, BUG_INTAKE_FIRESTORE_DATABASE: "(default)" })
        .BUG_INTAKE_FIRESTORE_DATABASE,
    ).toBe("(default)");
  });

  it.each([
    "BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY",
    "BUG_INTAKE_MAX_NEW_SUGGESTIONS_PER_DAY",
    "BUG_INTAKE_ISSUES_PAUSED",
    "BUG_INTAKE_MAX_REGISTRATIONS_PER_HOUR",
    "BUG_INTAKE_FIRESTORE_PROJECT",
    "BUG_INTAKE_FIRESTORE_DATABASE",
    "BUG_INTAKE_ISSUE_THRESHOLD_INSTALLS",
    "GITHUB_APP_PRIVATE_KEY",
  ])("refuses to start without %s and names it", (name) => {
    const { [name as keyof typeof complete]: _dropped, ...rest } = complete;
    expect(() => loadIntakeEnv(rest)).toThrow(new RegExp(`incomplete:[\\s\\S]*${name}`));
  });

  it("refuses an ambiguous kill switch and a cap below one", () => {
    expect(() => loadIntakeEnv({ ...complete, BUG_INTAKE_ISSUES_PAUSED: "yes" })).toThrow(
      /BUG_INTAKE_ISSUES_PAUSED/,
    );
    expect(() => loadIntakeEnv({ ...complete, BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY: "0" })).toThrow(
      /BUG_INTAKE_MAX_NEW_ISSUES_PER_DAY/,
    );
  });

  it("takes 0 suggestions per day (#1192) but refuses an empty or negative value", () => {
    expect(
      loadIntakeEnv({ ...complete, BUG_INTAKE_MAX_NEW_SUGGESTIONS_PER_DAY: "0" })
        .BUG_INTAKE_MAX_NEW_SUGGESTIONS_PER_DAY,
    ).toBe(0);
    for (const bad of ["", "-1", "2.5", "five"]) {
      expect(() =>
        loadIntakeEnv({ ...complete, BUG_INTAKE_MAX_NEW_SUGGESTIONS_PER_DAY: bad }),
      ).toThrow(/BUG_INTAKE_MAX_NEW_SUGGESTIONS_PER_DAY/);
    }
  });

  it("no longer knows a data repository: storage is Firestore", () => {
    expect(
      Object.keys(loadIntakeEnv({ ...complete, BUG_INTAKE_DATA_REPO: "o/data" })),
    ).not.toContain("BUG_INTAKE_DATA_REPO");
  });
});
