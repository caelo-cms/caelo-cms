// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { pluginTextsKeptAsIs } from "./audit.js";
import type { ChromeDeps } from "./chrome-ops.js";
import { textHash } from "./list-translation.js";

const address = (id: string) => `source/consent_categories/item/${id}/label`;

function deps(rows: readonly Record<string, unknown>[]): ChromeDeps {
  return {
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
    q: { list: async () => rows },
  } as unknown as ChromeDeps;
}

describe("#1323 — plugin texts a translation keeps as they are", () => {
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
