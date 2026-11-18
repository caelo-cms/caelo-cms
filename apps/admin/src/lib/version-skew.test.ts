// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  fullLoadTarget,
  RELOAD_GUARD_MS,
  type ReloadMemory,
  reloadIfNewerRelease,
} from "./version-skew.js";

const ORIGIN = "https://admin.example.test";
const to = (href: string) => ({ url: new URL(href) });

describe("fullLoadTarget (#1656)", () => {
  it("loads the target fully once a newer release is deployed", () => {
    expect(fullLoadTarget(true, { willUnload: false, to: to(`${ORIGIN}/edit?x=1`) }, ORIGIN)).toBe(
      `${ORIGIN}/edit?x=1`,
    );
  });

  it("lets the navigation run while the tab runs the deployed release", () => {
    expect(
      fullLoadTarget(false, { willUnload: false, to: to(`${ORIGIN}/edit`) }, ORIGIN),
    ).toBeNull();
  });

  it("leaves a navigation that unloads the page, or has no target, to the browser", () => {
    expect(fullLoadTarget(true, { willUnload: true, to: to(`${ORIGIN}/edit`) }, ORIGIN)).toBeNull();
    expect(fullLoadTarget(true, { willUnload: false, to: null }, ORIGIN)).toBeNull();
  });

  it("never sends the tab to another origin", () => {
    expect(
      fullLoadTarget(true, { willUnload: false, to: to("https://elsewhere.test/edit") }, ORIGIN),
    ).toBeNull();
  });
});

describe("reloadIfNewerRelease (#1656)", () => {
  const HREF = `${ORIGIN}/edit`;
  function tab(): ReloadMemory & { reloads: number; reload: () => void } {
    let stored: string | null = null;
    return {
      reloads: 0,
      reload() {
        this.reloads++;
      },
      get: () => stored,
      set: (v) => {
        stored = v;
      },
    };
  }

  it("reloads an error page shown by a tab older than the deployed release", async () => {
    const t = tab();
    expect(
      await reloadIfNewerRelease(
        async () => true,
        () => t.reload(),
        t,
        HREF,
        1_000,
      ),
    ).toBe(true);
    expect(t.reloads).toBe(1);
  });

  it("keeps a real error on screen once the tab runs the deployed release", async () => {
    const t = tab();
    expect(
      await reloadIfNewerRelease(
        async () => false,
        () => t.reload(),
        t,
        HREF,
        1_000,
      ),
    ).toBe(false);
    expect(t.reloads).toBe(0);
  });

  it("reloads one address once while the check keeps saying newer, then again later", async () => {
    const t = tab();
    let checks = 0;
    const newer = async () => {
      checks++;
      return true;
    };
    await reloadIfNewerRelease(newer, () => t.reload(), t, HREF, 1_000);
    expect(await reloadIfNewerRelease(newer, () => t.reload(), t, HREF, 2_000)).toBe(false);
    expect(checks).toBe(1);
    expect(await reloadIfNewerRelease(newer, () => t.reload(), t, `${ORIGIN}/`, 2_000)).toBe(true);
    expect(
      await reloadIfNewerRelease(newer, () => t.reload(), t, HREF, 2_000 + RELOAD_GUARD_MS),
    ).toBe(true);
    expect(t.reloads).toBe(3);
  });

  it("never reloads when the guard cannot be kept across the reload", async () => {
    let reloads = 0;
    const blocked: ReloadMemory = { get: () => null, set: () => undefined };
    for (const at of [1_000, 2_000, 3_000]) {
      expect(
        await reloadIfNewerRelease(
          async () => true,
          () => reloads++,
          blocked,
          HREF,
          at,
        ),
      ).toBe(false);
    }
    expect(reloads).toBe(0);
  });

  it("treats an unreadable memory as no earlier reload", async () => {
    const t = tab();
    t.set("not json");
    expect(
      await reloadIfNewerRelease(
        async () => true,
        () => t.reload(),
        t,
        HREF,
        1_000,
      ),
    ).toBe(true);
  });
});
