// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout D review) — a chrome translation carries the
 * source's stored links (`caelo:page/<id>` inside rich text) through the
 * translator and back. Without mapLinks, nothing downstream rewrites
 * them, so the write must go through core's link canonicalisation: a
 * path the translator wrote becomes a reference, a reference it broke
 * refuses the whole batch before any row is stored.
 */

import { describe, expect, it } from "bun:test";
import type { PluginAdminQuery } from "@caelo-cms/plugin-sdk";
import {
  type ChromeDeps,
  type PreparedChromeTranslation,
  writeChromeTranslation,
} from "./chrome-ops.js";

const ABOUT = "a1111111-1111-4111-8111-111111111111";
const fields = [{ name: "body", kind: "richtext" }];

function target(key: string) {
  return {
    id: key,
    target: {
      key,
      kind: "layout" as const,
      label: key,
      fields,
      values: { body: `<a href="caelo:page/${ABOUT}">About us</a>` },
    },
  };
}

function prepared(keys: string[]): PreparedChromeTranslation {
  return {
    locale: { code: "de", display_name: "Deutsch", is_default: false },
    sourceLocale: { code: "en", display_name: "English", is_default: true },
    upToDate: 0,
    skippedIndependent: 0,
    nothingToTranslate: 0,
    offered: keys.map(target),
    variants: [],
    glossary: [],
    styleGuide: null,
    prompt: { system: "", user: "" },
  } as unknown as PreparedChromeTranslation;
}

function fakeDeps(canonicalise: (input: { values: Record<string, unknown> }) => unknown) {
  const calls: { op: string; input: unknown }[] = [];
  const inserted: unknown[] = [];
  const deps = {
    cms: {
      call: async <O>(op: string, input: unknown): Promise<O> => {
        calls.push({ op, input });
        return canonicalise(input as { values: Record<string, unknown> }) as O;
      },
    },
    q: {
      insert: async (_t: string, row: unknown) => {
        inserted.push(row);
      },
      update: async () => {},
    } as unknown as PluginAdminQuery,
    locales: new Map(),
  } as unknown as ChromeDeps;
  return { deps, calls, inserted };
}

describe("writeChromeTranslation — links go through core canonicalisation", () => {
  it("stores the canonicalised values, grandfathering the source's links", async () => {
    const { deps, calls, inserted } = fakeDeps((input) => ({
      values: { body: String(input.values.body).replace('"/about"', `"caelo:page/${ABOUT}"`) },
    }));
    const n = await writeChromeTranslation(deps, prepared(["t1"]), {
      targets: [{ target: "t1", strings: { body: '<a href="/about">Über uns</a>' } }],
    });
    expect(n).toBe(1);
    expect(calls).toEqual([
      {
        op: "links.canonicalise_values",
        input: {
          fields,
          values: { body: '<a href="/about">Über uns</a>' },
          previous: { body: `<a href="caelo:page/${ABOUT}">About us</a>` },
        },
      },
    ]);
    expect((inserted[0] as { values: unknown }).values).toEqual({
      body: `<a href="caelo:page/${ABOUT}">Über uns</a>`,
    });
  });

  it("refuses the whole batch when one translation broke a link", async () => {
    let n = 0;
    const { deps, inserted } = fakeDeps((input) => {
      n += 1;
      if (n === 2) throw new Error("Internal link check failed — values.body: broken reference");
      return { values: input.values };
    });
    await expect(
      writeChromeTranslation(deps, prepared(["t1", "t2"]), {
        targets: [
          { target: "t1", strings: { body: `<a href="caelo:page/${ABOUT}">Über uns</a>` } },
          { target: "t2", strings: { body: '<a href="caelo:page/a111">Über uns</a>' } },
        ],
      }),
    ).rejects.toThrow("Internal link check failed");
    expect(inserted).toEqual([]);
  });
});
