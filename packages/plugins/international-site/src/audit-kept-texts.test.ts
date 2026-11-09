// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { indexCheckedQuery } from "@caelo-cms/plugin-sdk";
import { pluginTextsKeptAsIs } from "./audit.js";
import type { ChromeDeps } from "./chrome-ops.js";
import plugin, { type LocaleRow } from "./index.js";
import { textHash } from "./list-translation.js";

const address = (id: string) => `source/consent_categories/item/${id}/label`;

const locale = (code: string, isDefault: boolean): [string, LocaleRow] => [
  code,
  {
    id: `l-${code}`,
    code,
    display_name: code,
    url_strategy: "subdirectory",
    url_host: null,
    is_default: isDefault,
  },
];

/**
 * The store applies the host's read rule (#1536): a read no declared index
 * drives throws the host's error instead of answering.
 */
function deps(rows: readonly Record<string, unknown>[]): ChromeDeps {
  return {
    locales: new Map([locale("de", true), locale("en", false), locale("fr", false)]),
    cms: {
      call: async <O>(): Promise<O> =>
        ({
          sources: [
            {
              name: "consent_categories",
              label: "Consent categories",
              fields: [
                {
                  name: "label",
                  label: "Label",
                  type: "text",
                  ext: { "international-site": { translate: true } },
                },
              ],
              entries: [
                { id: "marketing", values: { label: "Marketing" } },
                { id: "necessary", values: { label: "Notwendig" } },
              ],
            },
          ],
        }) as O,
    },
    q: indexCheckedQuery(plugin, "adminSchema", {
      list: async (_table: string, filter: Record<string, unknown> = {}) =>
        rows.filter(
          (r) => filter.locale_code === undefined || r.locale_code === filter.locale_code,
        ),
    }),
  } as unknown as ChromeDeps;
}

describe("#1323 — plugin texts a translation keeps as they are", () => {
  it("#1536: reads per language, as the table's index (locale_code, address) needs", async () => {
    // Before the fix this read went out by address alone, and the host
    // refused it: Stage's audit errored and Publish live stayed blocked.
    const filters: Record<string, unknown>[] = [];
    const q = indexCheckedQuery(plugin, "adminSchema", {
      list: async (_table: string, filter: Record<string, unknown> = {}) => {
        filters.push(filter);
        return [];
      },
    });
    await pluginTextsKeptAsIs({ ...deps([]), q } as unknown as ChromeDeps, "page");
    expect(filters.map((f) => f.locale_code).sort()).toEqual(["en", "fr"]);
    await expect(
      q.list("list_value_translations", { anyOf: { address: [address("marketing")] } }),
    ).rejects.toThrow(
      'plugin_storage.list: no index covers this read of "list_value_translations" (it filters by address)',
    );
  });

  it("names a current translation that reads like its source, per language", async () => {
    const kept = await pluginTextsKeptAsIs(
      deps([
        {
          id: "a",
          locale_code: "en",
          address: address("marketing"),
          value: "Marketing",
          source_hash: textHash("Marketing"),
        },
        {
          id: "b",
          locale_code: "en",
          address: address("necessary"),
          value: "Necessary",
          source_hash: textHash("Notwendig"),
        },
      ]),
      "page",
    );
    expect([...(kept.get("en") ?? [])]).toEqual(["marketing"]);
  });

  it("an outdated translation proves nothing", async () => {
    const kept = await pluginTextsKeptAsIs(
      deps([
        {
          id: "a",
          locale_code: "en",
          address: address("marketing"),
          value: "Marketing",
          source_hash: textHash("Werbung"),
        },
      ]),
      "page",
    );
    expect(kept.size).toBe(0);
  });
});
