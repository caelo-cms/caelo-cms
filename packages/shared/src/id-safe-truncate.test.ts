// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { idSafeCutIndex, truncateKeepingIds } from "./id-safe-truncate.js";

const ID = "c9c7ddcb-cc85-4747-84fa-90967da6f769";

describe("idSafeCutIndex (#1094)", () => {
  it("moves a cut inside a UUID back to just before it", () => {
    const text = `ref ${ID} tail`;
    // 4 = where the id starts; every cut inside it lands there.
    for (let at = 5; at < 4 + ID.length; at++) expect(idSafeCutIndex(text, at)).toBe(4);
  });

  it("keeps a cut that does not split an id", () => {
    const text = `ref ${ID} tail`;
    expect(idSafeCutIndex(text, 4)).toBe(4);
    expect(idSafeCutIndex(text, 4 + ID.length)).toBe(4 + ID.length);
    expect(idSafeCutIndex("plain text here", 5)).toBe(5);
  });
});

describe("truncateKeepingIds", () => {
  it("never leaves a UUID fragment before the suffix", () => {
    const text = `contentInstanceId: ${ID}, more`;
    const out = truncateKeepingIds(text, 45);
    expect(out).toBe("contentInstanceId: …");
    expect(truncateKeepingIds(text, 80)).toBe(text);
  });

  it("keeps a whole id that fits", () => {
    const text = `id ${ID} and a long trailing explanation`;
    expect(truncateKeepingIds(text, 3 + ID.length + 2)).toBe(`id ${ID} …`);
  });
});
