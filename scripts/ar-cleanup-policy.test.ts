// SPDX-License-Identifier: MPL-2.0

/**
 * #1558 contract over `docs/maintainer-ar-cleanup-policy.json`, the cleanup
 * policy of the GCP Artifact Registry mirror Cloud Run installs pull from.
 *
 * A release is never deleted there: Cloud Run services keep running on the
 * copy they imported at deploy time, but Cloud Run jobs (the upgrader, the
 * converge job, the quality audit, page captures) pull their image when they
 * run, so an install whose release vanished from the registry loses its
 * updates and audits. A release candidate is for test installs only and
 * goes after 14 days, by its marker tag `rc-<version>`.
 *
 * The evaluation below follows Artifact Registry's documented rules: a
 * TAGGED condition with `tagPrefixes` matches a version when one of its tags
 * starts with one of the prefixes ("Applied on any prefix match"), every
 * field of a condition must hold, and a keep policy beats a delete policy.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RELEASE_CANDIDATE_RETENTION_DAYS,
  RELEASE_CANDIDATE_TAG_PREFIX,
} from "../packages/provisioning/src/release-candidate.ts";

interface Policy {
  readonly name: string;
  readonly action: { readonly type: "Delete" | "Keep" };
  readonly condition?: {
    readonly tagState?: "TAGGED" | "UNTAGGED" | "ANY";
    readonly tagPrefixes?: readonly string[];
    readonly olderThan?: string;
  };
  readonly mostRecentVersions?: { readonly keepCount: number };
}

const policies = JSON.parse(
  readFileSync(resolve(import.meta.dir, "../docs/maintainer-ar-cleanup-policy.json"), "utf8"),
) as readonly Policy[];

/** Days in an `olderThan` duration (`14d`). */
function days(duration: string): number {
  const m = /^(\d+)d$/.exec(duration);
  if (!m) throw new Error(`unexpected olderThan ${duration}`);
  return Number(m[1]);
}

/** The delete rules that match a version with `tags`, `ageDays` old (keep rules aside). */
function deleteRulesMatching(tags: readonly string[], ageDays: number): string[] {
  return policies
    .filter((p) => p.action.type === "Delete" && p.condition)
    .filter((p) => {
      const c = p.condition ?? {};
      if (c.tagState === "TAGGED" && tags.length === 0) return false;
      if (c.tagState === "UNTAGGED" && tags.length > 0) return false;
      if (c.tagPrefixes && !tags.some((t) => c.tagPrefixes?.some((pre) => t.startsWith(pre)))) {
        return false;
      }
      return c.olderThan === undefined || ageDays > days(c.olderThan);
    })
    .map((p) => p.name);
}

/** The tags release-images.yml gives each kind of build (its metadata-action config). */
const STABLE_TAGS = ["0.12.4", "0.12", "latest"];
const OLDER_STABLE_TAGS = ["0.12.3"];
const RC_TAGS = ["0.12.5-rc.1", `${RELEASE_CANDIDATE_TAG_PREFIX}0.12.5-rc.1`];

describe("docs/maintainer-ar-cleanup-policy.json (#1558)", () => {
  it("keeps every stable release, however old: no delete rule matches it", () => {
    for (const tags of [STABLE_TAGS, OLDER_STABLE_TAGS]) {
      expect(deleteRulesMatching(tags, 10_000)).toEqual([]);
    }
  });

  it("deletes a release candidate by its marker tag once it is 14 days old", () => {
    expect(deleteRulesMatching(RC_TAGS, RELEASE_CANDIDATE_RETENTION_DAYS)).toEqual([]);
    expect(deleteRulesMatching(RC_TAGS, RELEASE_CANDIDATE_RETENTION_DAYS + 1)).toEqual([
      "delete-release-candidates-after-14d",
    ]);
  });

  it("agrees with the retention the CLI warns about", () => {
    const rule = policies.find((p) => p.name === "delete-release-candidates-after-14d");
    expect(rule?.condition).toEqual({
      tagState: "TAGGED",
      tagPrefixes: [RELEASE_CANDIDATE_TAG_PREFIX],
      olderThan: `${RELEASE_CANDIDATE_RETENTION_DAYS}d`,
    });
  });

  it("no stable tag the pipeline writes starts with a delete prefix", () => {
    const prefixes = policies.flatMap((p) => p.condition?.tagPrefixes ?? []);
    for (const tag of STABLE_TAGS) {
      for (const prefix of prefixes) expect(tag.startsWith(prefix)).toBe(false);
    }
  });

  it("keeps its backstop for idle weeks: the 10 most recent versions of each package", () => {
    const keep = policies.filter((p) => p.action.type === "Keep");
    expect(keep).toEqual([
      {
        name: "keep-10-most-recent-versions",
        action: { type: "Keep" },
        mostRecentVersions: { keepCount: 10 },
      },
    ]);
  });
});
