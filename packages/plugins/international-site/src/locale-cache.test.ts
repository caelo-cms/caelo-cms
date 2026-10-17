// SPDX-License-Identifier: MPL-2.0

/**
 * #847 — the URL decode half reads a module-level mirror of the LIVE
 * locale registry. A chat branch reads its own (unpublished) locales;
 * those reads must not overwrite the mirror, or a draft locale would
 * start decoding on the live site before publish.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";

type Row = Record<string, unknown>;

function ctxFor(tables: { locales: Row[]; settings: Row[] }, chatBranchId?: string) {
  return {
    invocation: { origin: chatBranchId ? "chat" : "system", actorId: "a", chatBranchId },
    adminQuery: {
      list: async (table: string) => {
        if (table === "locales") return tables.locales;
        if (table === "settings") return tables.settings;
        return [];
      },
    },
  } as unknown as PluginContextTier1;
}

const EN = {
  id: "l-en",
  code: "en",
  display_name: "English",
  url_strategy: "subdirectory",
  url_host: null,
  is_default: true,
};

const MAIN = { locales: [EN], settings: [] };
const BRANCH = {
  locales: [
    EN,
    {
      id: "l-fr",
      code: "fr",
      display_name: "French",
      url_strategy: "subdirectory",
      url_host: null,
      is_default: false,
    },
    {
      id: "l-de",
      code: "de",
      display_name: "German",
      url_strategy: "domain",
      url_host: "example.de",
      is_default: false,
    },
  ],
  settings: [{ id: "s1", key: "prefix_default_locale", value: { enabled: true } }],
};

function decoders() {
  const prefix = plugin.urlContributions?.find((c) => c.slot === "path-prefix");
  const host = plugin.urlContributions?.find((c) => c.slot === "host");
  if (!prefix?.decode || !host?.decode) throw new Error("url contributions missing");
  return {
    path: (segments: string[]) => (prefix.decode as (s: string[]) => unknown)(segments),
    host: (h: string) => (host.decode as (s: string) => unknown)(h),
  };
}

const refresh = (ctx: PluginContextTier1) => {
  const op = plugin.operations.refresh_locales;
  if (!op) throw new Error("refresh_locales missing");
  return op(ctx, {});
};

describe("live locale mirror vs chat-branch reads", () => {
  it("a branch read leaves the live decode mirror untouched", async () => {
    const d = decoders();
    await refresh(ctxFor(MAIN));
    expect(d.path(["fr", "about"])).toBeNull();
    expect(d.path(["en", "about"])).toBeNull(); // default not prefixed on main

    // The branch sees its own registry (3 locales, prefix on)…
    expect(await refresh(ctxFor(BRANCH, "branch-1"))).toEqual({ locales: 3 });

    // …but the live mirror still decodes exactly what main has.
    expect(d.path(["fr", "about"])).toBeNull();
    expect(d.host("example.de")).toBeNull();
    expect(d.path(["en", "about"])).toBeNull(); // prefixDefaultLocale not leaked
  });

  it("a main read does update the mirror", async () => {
    const d = decoders();
    await refresh(ctxFor(BRANCH));
    expect(d.path(["fr", "about"])).toEqual({ consumed: 1, annotations: { locale: "fr" } });
    expect(d.host("example.de")).toEqual({ annotations: { locale: "de" } });
    expect(d.path(["en"])).toEqual({ consumed: 1, annotations: { locale: "en" } });
    await refresh(ctxFor(MAIN));
    expect(d.path(["fr", "about"])).toBeNull();
  });
});
