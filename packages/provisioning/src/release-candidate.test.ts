// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  ACCEPT_RELEASE_CANDIDATE_FLAG,
  confirmReleaseCandidate,
  isPrereleaseVersion,
  RELEASE_CANDIDATE_RETENTION_DAYS,
  releaseCandidateWarning,
  resolveChannelVersion,
} from "./release-candidate.js";

/** A prompt fake: records what was shown and asked, answers `answer`. */
function fakePrompt(answer: boolean) {
  const warned: string[][] = [];
  const asked: string[] = [];
  return {
    warned,
    asked,
    prompt: {
      warn: (lines: readonly string[]) => {
        warned.push([...lines]);
      },
      confirm: async (message: string) => {
        asked.push(message);
        return answer;
      },
    },
  };
}

describe("isPrereleaseVersion", () => {
  it("is true for a version with a pre-release part, with or without a v", () => {
    for (const v of ["0.12.5-rc.1", "v0.12.5-rc.1", "0.13.0-beta.2", "1.0.0-alpha"]) {
      expect(isPrereleaseVersion(v)).toBe(true);
    }
  });

  it("is false for a stable release and for anything that is not a version", () => {
    for (const v of ["0.12.4", "v0.12.4", "latest", "rc", "rc-0.12.5-rc.1", ""]) {
      expect(isPrereleaseVersion(v)).toBe(false);
    }
  });
});

describe("releaseCandidateWarning", () => {
  const text = releaseCandidateWarning("v0.12.5-rc.1").join("\n");

  it("names the release and when its images are deleted", () => {
    expect(text).toContain("v0.12.5-rc.1 is a release candidate");
    expect(text).toContain(`${RELEASE_CANDIDATE_RETENTION_DAYS} days after it was published`);
  });

  it("says what stops working: the jobs, not the services", () => {
    // Cloud Run services import a copy of their image at deploy time; jobs
    // pull theirs on every run (#1558 correction).
    expect(text).toContain("services keep running on their own copy");
    for (const job of ["update", "converge", "quality audit", "page capture"]) {
      expect(text).toContain(job);
    }
    expect(text).toContain("Settings → Updates");
    expect(text).toContain("audit a Stage");
    expect(text).not.toContain("new instances");
  });
});

describe("confirmReleaseCandidate", () => {
  const rc = { version: "0.12.5-rc.1", action: "install" as const };

  it("lets a stable release through without a word", async () => {
    const f = fakePrompt(false);
    const r = await confirmReleaseCandidate(
      { version: "0.12.4", action: "upgrade", interactive: true, accepted: false },
      f.prompt,
    );
    expect(r).toEqual({ ok: true });
    expect(f.warned).toEqual([]);
    expect(f.asked).toEqual([]);
  });

  it("asks in a terminal, defaulting to the operator's answer", async () => {
    const yes = fakePrompt(true);
    expect(
      await confirmReleaseCandidate({ ...rc, interactive: true, accepted: false }, yes.prompt),
    ).toEqual({ ok: true });
    expect(yes.warned).toHaveLength(1);
    expect(yes.asked).toEqual(["Install release candidate v0.12.5-rc.1 anyway?"]);

    const no = fakePrompt(false);
    const declined = await confirmReleaseCandidate(
      { version: "v0.12.5-rc.1", action: "upgrade", interactive: true, accepted: false },
      no.prompt,
    );
    expect(declined.ok).toBe(false);
    expect(declined.ok === false && declined.reason).toBe("declined");
    expect(declined.ok === false && declined.message).toContain("upgrade to a stable release");
    expect(no.asked).toEqual(["Upgrade to release candidate v0.12.5-rc.1 anyway?"]);
  });

  it("refuses where no prompt can ask, naming the flag that confirms", async () => {
    const f = fakePrompt(true);
    const r = await confirmReleaseCandidate(
      { ...rc, interactive: false, accepted: false },
      f.prompt,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("needs-flag");
    expect(r.ok === false && r.message).toContain(ACCEPT_RELEASE_CANDIDATE_FLAG);
    expect(r.ok === false && r.message).toContain("To install it without a prompt");
    // The warning is shown either way; nothing is asked.
    expect(f.warned).toHaveLength(1);
    expect(f.asked).toEqual([]);
    const upgrade = await confirmReleaseCandidate(
      { version: "0.12.5-rc.1", action: "upgrade", interactive: false, accepted: false },
      fakePrompt(true).prompt,
    );
    expect(upgrade.ok === false && upgrade.message).toContain("To upgrade to it without a prompt");
  });

  it("takes the flag as the confirmation, still showing the warning", async () => {
    const f = fakePrompt(false);
    expect(
      await confirmReleaseCandidate({ ...rc, interactive: false, accepted: true }, f.prompt),
    ).toEqual({ ok: true });
    expect(f.warned).toHaveLength(1);
    expect(f.asked).toEqual([]);
  });
});

/** A fetch fake answering the GitHub releases list with `releases`. */
function releasesFetch(releases: unknown, status = 200) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json(releases, { status });
  }) as typeof fetch;
  return { impl, urls };
}

const rel = (tag_name: string, draft = false) => ({ tag_name, draft });

describe("resolveChannelVersion", () => {
  it("picks the newest release candidate while it is newer than the newest stable", async () => {
    const f = releasesFetch([rel("v0.12.5-rc.2"), rel("v0.12.5-rc.1"), rel("v0.12.4")]);
    expect(await resolveChannelVersion("rc", f.impl)).toEqual({
      ok: true,
      version: "0.12.5-rc.2",
    });
    expect(f.urls).toEqual([
      "https://api.github.com/repos/caelo-cms/caelo-cms/releases?per_page=100",
    ]);
  });

  it("picks the final release once it is out, never the older candidate", async () => {
    const f = releasesFetch([rel("v0.12.5"), rel("v0.12.5-rc.1"), rel("v0.12.4")]);
    expect(await resolveChannelVersion("rc", f.impl)).toEqual({ ok: true, version: "0.12.5" });
  });

  it("keeps rc away from betas, and lets beta take rc and stable releases", async () => {
    const list = [rel("v0.13.0-beta.1"), rel("v0.12.5-rc.1"), rel("v0.12.4")];
    expect(await resolveChannelVersion("rc", releasesFetch(list).impl)).toEqual({
      ok: true,
      version: "0.12.5-rc.1",
    });
    expect(await resolveChannelVersion("beta", releasesFetch(list).impl)).toEqual({
      ok: true,
      version: "0.13.0-beta.1",
    });
  });

  it("ignores drafts, malformed tags and unknown pre-release channels", async () => {
    const f = releasesFetch([
      rel("v0.13.0-rc.1", true),
      rel("not-a-version"),
      rel("v0.13.0-nightly.1"),
      { draft: false },
      rel("v0.12.4"),
    ]);
    expect(await resolveChannelVersion("rc", f.impl)).toEqual({ ok: true, version: "0.12.4" });
  });

  it("reports GitHub failures and an empty answer instead of guessing", async () => {
    const down = await resolveChannelVersion("rc", releasesFetch({}, 503).impl);
    expect(down.ok).toBe(false);
    expect(down.ok === false && down.reason).toContain("503");
    const notList = await resolveChannelVersion("rc", releasesFetch({ message: "x" }).impl);
    expect(notList.ok).toBe(false);
    const none = await resolveChannelVersion("rc", releasesFetch([]).impl);
    expect(none).toEqual({ ok: false, reason: "no rc or stable release on GitHub" });
  });
});
