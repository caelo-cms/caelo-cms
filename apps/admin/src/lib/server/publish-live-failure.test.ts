// SPDX-License-Identifier: MPL-2.0

/**
 * #1591 — a failed Publish live names its reason on every surface: a
 * refusal is the operator's to act on (409), a fault of the server stays a
 * 500 — with its reason as well, never a bare "failed.".
 */

import { describe, expect, it } from "bun:test";
import { isPublishRefusal, publishLiveFailureText } from "./publish-live-failure.js";

describe("publishLiveFailureText", () => {
  it("answers a guard refusal with 409 and the op's reason", () => {
    const error = {
      kind: "HandlerError",
      operation: "deploy.promote",
      message: "no succeeded build to promote from 'staging' — run Stage first",
      refusal: true,
    };
    expect(publishLiveFailureText("Promote staging → production", error)).toEqual({
      status: 409,
      error:
        "Promote staging → production refused: no succeeded build to promote from 'staging' — run Stage first",
    });
  });

  it("keeps a fault of the server a 500, with its reason", () => {
    const error = {
      kind: "HandlerError",
      operation: "deploy.promote",
      message: "promotion failed: the bucket copy timed out",
    };
    expect(publishLiveFailureText("Publish live", error)).toEqual({
      status: 500,
      error: "Publish live failed: promotion failed: the bucket copy timed out",
    });
  });

  it("treats conflicts and calls the op does not accept as refusals, defects as faults", () => {
    expect(
      isPublishRefusal({ kind: "HandlerError", operation: "x", message: "m", conflict: true }),
    ).toBe(true);
    expect(isPublishRefusal({ kind: "ActorScopeRejected", operation: "x", actorKind: "ai" })).toBe(
      true,
    );
    expect(
      isPublishRefusal({ kind: "HandlerError", operation: "x", message: "m", internal: true }),
    ).toBe(false);
    expect(isPublishRefusal(null)).toBe(false);
  });
});
