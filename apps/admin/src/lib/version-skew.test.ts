// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  fullLoad,
  RELOAD_GUARD_MS,
  type ReloadMemory,
  reloadIfNewerRelease,
} from "./version-skew.js";

const ORIGIN = "https://admin.example.test";
const to = (href: string) => ({ url: new URL(href) });

describe("fullLoad (#1656)", () => {
  const link = (href: string | null, willUnload = false) => ({
    type: "link",
    willUnload,
    to: href === null ? null : to(href),
  });

  it("cancels the client-side navigation and loads the target once a newer release is deployed", () => {
    expect(fullLoad(true, link(`${ORIGIN}/edit?x=1`), ORIGIN)).toEqual({
      kind: "load",
      href: `${ORIGIN}/edit?x=1`,
    });
    expect(fullLoad(true, { ...link(`${ORIGIN}/`), type: "goto" }, ORIGIN)).toEqual({
      kind: "load",
      href: `${ORIGIN}/`,
    });
  });

  it("reloads a back/forward step at the address the browser already shows", () => {
    expect(fullLoad(true, { ...link(`${ORIGIN}/edit#chat`), type: "popstate" }, ORIGIN)).toEqual({
      kind: "reload",
    });
  });

  it("lets the navigation run while the tab runs the deployed release", () => {
    expect(fullLoad(false, link(`${ORIGIN}/edit`), ORIGIN)).toBeNull();
    expect(fullLoad(false, { ...link(`${ORIGIN}/edit`), type: "popstate" }, ORIGIN)).toBeNull();
  });

  it("leaves a navigation that unloads the page, or has no target, to the browser", () => {
    expect(fullLoad(true, link(`${ORIGIN}/edit`, true), ORIGIN)).toBeNull();
    expect(fullLoad(true, link(null), ORIGIN)).toBeNull();
  });

  it("never sends the tab to another origin", () => {
    expect(fullLoad(true, link("https://elsewhere.test/edit"), ORIGIN)).toBeNull();
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
