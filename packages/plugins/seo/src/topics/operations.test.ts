// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import { PAGE_LOOKUP_BATCH, readVocabularies } from "./operations.js";

const uuid = (prefix: string, n: number) =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("readVocabularies (#1759; Codex on #1797)", () => {
  it("looks the overview pages up in calls of at most 1,000 ids, however many the vocabularies name", async () => {
    // Three vocabularies of 500 terms, each term with its own overview page: 1,500 ids.
    const lists = [1, 2, 3].map((l) => ({
      id: uuid("a", l),
      slug: `v${l}`,
      name: `V${l}`,
      items: Array.from({ length: 500 }, (_, i) => ({
        id: uuid("b", l * 1000 + i),
        values: {
          name: `t${l}-${i}`,
          landing_page: { href: `caelo:page/${uuid("c", l * 1000 + i)}` },
        },
      })),
    }));
    const sizes: number[] = [];
    const cms = {
      call: async (op: string, input: { pageIds?: string[] }) => {
        if (op === "lists.list") return { lists };
        if (op === "pages.list") {
          const ids = input.pageIds ?? [];
          if (ids.length > PAGE_LOOKUP_BATCH) throw new Error("pageIds over the op's limit");
          sizes.push(ids.length);
          return { pages: ids.map((id) => ({ id, currentPath: `/topics/${id}` })) };
        }
        throw new Error(`unexpected ${op}`);
      },
    };
    const vocabularies = await readVocabularies({ cms } as unknown as PluginContextTier1);
    expect(sizes).toEqual([1000, 500]);
    expect(vocabularies.flatMap((v) => v.terms).filter((t) => t.topicPage !== null)).toHaveLength(
      1500,
    );
  });
});
