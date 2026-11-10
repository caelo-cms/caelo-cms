// SPDX-License-Identifier: MPL-2.0

/**
 * #1269 — which list translation targets a batch of changes names, and
 * when it needs the whole reconcile instead.
 */

import { describe, expect, it } from "bun:test";
import type { ChromeDeps } from "./chrome-ops.js";
import type { PageVariantRow } from "./index.js";
import { type ListChange, reconcileScopeOf } from "./list-reconcile.js";
import { targetOfAddress } from "./list-translation.js";

const V1 = "00000000-0000-4000-8000-000000000001";
const P1 = "00000000-0000-4000-8000-0000000000a1";
const M1 = "00000000-0000-4000-8000-0000000000b1";
const CI = "00000000-0000-4000-8000-0000000000c1";

/** Deps whose store holds `variants` and whose core answers `instancesOf`. */
function depsWith(variants: PageVariantRow[], instancesOfModule: string[] = []): ChromeDeps {
  return {
    q: {
      list: async (_table: string, filter?: { anyOf?: { id?: string[] } }) =>
        variants.filter((v) => filter?.anyOf?.id?.includes(v.id) ?? false),
    },
    cms: {
      call: async (op: string) => {
        if (op === "pages.list_shared_content") return { listInstances: [] };
        if (op === "content_instances.list") {
          return { instances: instancesOfModule.map((id) => ({ id })) };
        }
        throw new Error(`unexpected ${op}`);
      },
    },
    locales: new Map(),
    listTypes: new Map(),
  } as unknown as ChromeDeps;
}

const change = (c: Partial<ListChange> & Pick<ListChange, "kind" | "rowId">): ListChange => ({
  op: "update",
  parentId: null,
  table: null,
  changedColumns: null,
  ...c,
});

describe("#1269 — reconcileScopeOf", () => {
  it("a soft-deleted variant (its row no longer reads) takes the whole reconcile", async () => {
    const r = await reconcileScopeOf(depsWith([]), [
      change({
        kind: "own",
        table: "page_variants",
        rowId: V1,
        changedColumns: ["caelo_deleted_at"],
      }),
      // …and its history snapshot, naming the same row.
      change({ kind: "own", table: "page_variants", rowId: V1, op: "insert" }),
    ]);
    expect(r).toEqual({ whole: "a removed page variant no longer names its page" });
  });

  it("a variant written names its page", async () => {
    const v = { id: V1, page_id: P1, group_id: V1, locale_code: "de" } as PageVariantRow;
    const r = await reconcileScopeOf(depsWith([v]), [
      change({ kind: "own", table: "page_variants", rowId: V1, op: "insert" }),
    ]);
    expect("scope" in r && r.scope !== "all" && [...r.scope.pages]).toEqual([P1]);
  });

  it("the site's languages changing takes the whole reconcile", async () => {
    const r = await reconcileScopeOf(depsWith([]), [
      change({ kind: "own", table: "locales", rowId: V1, op: "insert" }),
    ]);
    expect(r).toEqual({ whole: "the site's languages changed" });
  });

  it("a module removed or restored names its instances; a markup edit names none", async () => {
    const removed = await reconcileScopeOf(depsWith([], [CI]), [
      change({ kind: "module", rowId: M1, changedColumns: ["deleted_at"] }),
    ]);
    expect("scope" in removed && removed.scope !== "all" && [...removed.scope.instances]).toEqual([
      CI,
    ]);
    const markup = await reconcileScopeOf(depsWith([], [CI]), [
      change({ kind: "module", rowId: M1, changedColumns: ["html"] }),
    ]);
    expect("scope" in markup && markup.scope !== "all" && markup.scope.instances.size).toBe(0);
  });
});

describe("#1269 — targetOfAddress", () => {
  it("names the list, instance or plugin source of a value address", () => {
    expect(targetOfAddress("list/L/item/I/label")).toBe("list:L");
    expect(targetOfAddress("instance/C/menu/item/I/label")).toBe("instance:C");
    expect(targetOfAddress("source/consent/item/I/text")).toBe("source:consent");
    expect(() => targetOfAddress("page/P/props/author")).toThrow("names no list");
  });
});
