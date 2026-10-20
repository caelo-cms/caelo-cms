// SPDX-License-Identifier: MPL-2.0

/**
 * Which job installs a release (update-route.ts, #819): the upgrader for
 * an app-roll, the converge job for a cloud-setup change — the same
 * button either way — and a refusal that says what to do instead when the
 * install cannot converge from Caelo.
 */

import { describe, expect, it } from "bun:test";
import { chooseUpdateRoute, type UpdateRouteInput } from "./update-route.js";

const INPUT: UpdateRouteInput = {
  provider: "gcp-firebase",
  targetVersion: "0.11.0",
  infraChange: false,
  lastAttempt: null,
  convergeAvailable: true,
};

const route = (over: Partial<UpdateRouteInput>) => {
  const r = chooseUpdateRoute({ ...INPUT, ...over });
  return r.ok ? r.route : `error: ${r.error}`;
};

describe("chooseUpdateRoute", () => {
  it("routes by the release manifest: a contract bump goes to the converge job", () => {
    expect(route({})).toBe("app_roll");
    expect(route({ infraChange: true })).toBe("converge");
    expect(route({ infraChange: true, provider: "gcp" })).toBe("converge");
  });

  it("an unreadable manifest leaves it to the upgrader, which re-checks the signed one", () => {
    expect(route({ infraChange: null })).toBe("app_roll");
  });

  it("follows the upgrader's own answer for the same release", () => {
    const told = {
      targetVersion: "0.11.0",
      status: "needs_cloud_shell" as const,
      route: "app_roll" as const,
      refusalCodes: ["infra-contract"],
    };
    expect(route({ infraChange: null, lastAttempt: told })).toBe("converge");
    // About another release, or another reason: not this one's route.
    expect(route({ infraChange: null, lastAttempt: { ...told, targetVersion: "0.10.99" } })).toBe(
      "app_roll",
    );
    expect(
      route({ infraChange: null, lastAttempt: { ...told, refusalCodes: ["state-access"] } }),
    ).toBe("app_roll");
  });

  it("tries an unfinished converge of the same release again on the converge route (it resumes)", () => {
    for (const status of ["failed", "rolled_back", "refused"] as const) {
      expect(
        route({
          infraChange: null,
          lastAttempt: { targetVersion: "0.11.0", status, route: "converge", refusalCodes: [] },
        }),
      ).toBe("converge");
    }
  });

  it("self-hosted never converges separately", () => {
    expect(route({ provider: "self-hosted", infraChange: true })).toBe("app_roll");
  });

  it("refuses loudly, with the way out, when this install cannot converge from Caelo", () => {
    expect(route({ infraChange: true, convergeAvailable: false })).toContain(
      "Install it from Google Cloud Shell or the computer you installed from",
    );
    expect(route({ infraChange: true, provider: "aws" })).toContain(
      "available on Google Cloud installs only so far; on AWS run the upgrade",
    );
    expect(route({ infraChange: true, provider: "azure" })).toContain("on Azure");
  });
});
