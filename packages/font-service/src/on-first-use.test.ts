// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { onFirstUse } from "./on-first-use.js";

describe("onFirstUse", () => {
  it("loads nothing until called, then loads once however often it is called", async () => {
    let loads = 0;
    const get = onFirstUse(async () => {
      loads += 1;
      return { default: { name: "toolchain" } };
    });
    expect(loads).toBe(0);
    const [a, b] = await Promise.all([get(), get()]);
    expect(await get()).toBe(a);
    expect(b).toBe(a);
    expect(loads).toBe(1);
  });

  it("does not keep a failed load: the next call loads again", async () => {
    let loads = 0;
    const get = onFirstUse(async () => {
      loads += 1;
      if (loads === 1) throw new Error("Cannot find module 'fontverter'");
      return { default: 42 };
    });
    await expect(get()).rejects.toThrow("Cannot find module 'fontverter'");
    expect(await get()).toBe(42);
    expect(loads).toBe(2);
  });
});
