// SPDX-License-Identifier: MPL-2.0
import { describe, expect, test } from "bun:test";
import { DEFAULT_LIST_TYPES, type ListTypeDef } from "@caelo-cms/shared";
import {
  addableKinds,
  canPlace,
  countItems,
  type EditorItem,
  fromStored,
  indentItem,
  moveItem,
  newItem,
  outdentItem,
  positionOf,
  removeItem,
  replaceLevel,
  shiftItem,
  structureIssues,
  toSavedItems,
  toStored,
  updateItem,
} from "./tree.js";

const MENU = DEFAULT_LIST_TYPES.find((t) => t.slug === "menu") as ListTypeDef;

/** A mega menu: columns under top entries, links under columns, a feed with a source. */
const MEGA: ListTypeDef = {
  slug: "mega",
  name: "Mega",
  purpose: "test",
  role: "navigation",
  root: { allow: ["top"], max: 3 },
  nodes: {
    top: {
      label: "Top",
      fields: [{ name: "label", label: "Label", type: "text", required: true }],
      children: { name: "columns", allow: ["column", "feed"], max: 2 },
    },
    column: {
      label: "Column",
      fields: [{ name: "label", label: "Label", type: "text" }],
      children: { name: "links", allow: ["link"] },
    },
    link: {
      label: "Link",
      fields: [{ name: "label", label: "Label", type: "text", default: "New link" }],
    },
    feed: {
      label: "Feed",
      fields: [],
      source: { kind: "query", editable: ["limit"], defaults: { order: "title_asc", limit: 3 } },
    },
  },
};

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const item = (node: string, children: EditorItem[] = [], itemId = id()): EditorItem => ({
  id: itemId,
  node,
  values: { label: node },
  children,
});

describe("stored ↔ editor shape", () => {
  test("round trip keeps ids, drops empty children, assigns missing ids", () => {
    const tree = fromStored(
      [
        {
          id: "a",
          node: "entry",
          values: { label: "A" },
          children: [{ node: "entry", values: {} }],
        },
        { node: "entry", values: {}, query: {} },
      ],
      () => "minted",
    );
    expect(tree[0]?.children[0]?.id).toBe("minted");
    expect(tree[1]?.children).toEqual([]);
    const stored = toStored(tree);
    expect(stored[0]?.id).toBe("a");
    expect(stored[1]).toEqual({ id: "minted", node: "entry", values: {} });
    expect(countItems(tree)).toBe(3);
  });
});

describe("placement rules", () => {
  test("node kinds follow allow per level", () => {
    const top = item("top");
    const tree = [top];
    expect(canPlace(MEGA, tree, item("column"), top.id).ok).toBe(true);
    const atRoot = canPlace(MEGA, tree, item("column"), null);
    expect(atRoot.ok).toBe(false);
    if (!atRoot.ok) expect(atRoot.reason).toContain("not allowed at the top level");
    expect(addableKinds(MEGA, tree, top.id)).toEqual(["column", "feed"]);
  });

  test("a source node takes no children", () => {
    const feed = item("feed");
    const tree = [item("top", [feed])];
    const r = canPlace(MEGA, tree, item("link"), feed.id);
    expect(r.ok).toBe(false);
    expect(addableKinds(MEGA, tree, feed.id)).toEqual([]);
  });

  test("max per level counts the level, not a re-placed entry", () => {
    const tree = [item("top"), item("top"), item("top")];
    expect(canPlace(MEGA, tree, item("top"), null).ok).toBe(false);
    expect(addableKinds(MEGA, tree, null)).toEqual([]);
    // Reordering inside the full level is still fine.
    const moved = moveItem(MEGA, tree, (tree[2] as EditorItem).id, null, 0);
    expect(moved.check.ok).toBe(true);
    expect(moved.items[0]?.id).toBe((tree[2] as EditorItem).id);
  });

  test("depth counts the moved entry's whole subtree", () => {
    // menu: max_depth 3. A two-level subtree may go under a depth-1 entry, not a depth-2 one.
    const leaf = item("entry");
    const mid = item("entry", [leaf]);
    const a = item("entry");
    const deep = item("entry");
    const b = item("entry", [deep]);
    const tree = [mid, a, b];
    expect(moveItem(MENU, tree, mid.id, a.id, 0).check.ok).toBe(true);
    const r = moveItem(MENU, tree, mid.id, deep.id, 0);
    expect(r.check.ok).toBe(false);
    if (!r.check.ok) expect(r.check.reason).toContain("at most 3 levels");
    expect(r.items).toEqual(tree);
  });

  test("an entry cannot move into its own subtree", () => {
    const child = item("entry");
    const parent = item("entry", [child]);
    const r = moveItem(MENU, [parent], parent.id, child.id, 0);
    expect(r.check.ok).toBe(false);
  });
});

describe("keyboard moves", () => {
  test("shift, indent, outdent", () => {
    const a = item("entry");
    const b = item("entry");
    let tree = [a, b];
    tree = shiftItem(MENU, tree, b.id, -1).items;
    expect(tree.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(shiftItem(MENU, tree, b.id, -1).check.ok).toBe(false);
    tree = indentItem(MENU, tree, a.id).items;
    expect(positionOf(tree, a.id)).toEqual({ parentId: b.id, index: 0 });
    expect(indentItem(MENU, tree, b.id).check.ok).toBe(false);
    tree = outdentItem(MENU, tree, a.id).items;
    expect(positionOf(tree, a.id)).toEqual({ parentId: null, index: 1 });
    expect(outdentItem(MENU, tree, a.id).check.ok).toBe(false);
  });

  test("indent respects the type: a link cannot nest under a link", () => {
    const l1 = item("link");
    const l2 = item("link");
    const tree = [item("top", [item("column", [l1, l2])])];
    const r = indentItem(MEGA, tree, l2.id);
    expect(r.check.ok).toBe(false);
  });
});

describe("edits", () => {
  test("new entries start with field defaults", () => {
    expect(newItem(MEGA, "link", "x").values).toEqual({ label: "New link" });
  });

  test("update and remove reach nested entries", () => {
    const child = item("entry");
    let tree = [item("entry", [child])];
    tree = updateItem(tree, child.id, (it) => ({ ...it, values: { label: "Z" } }));
    expect(tree[0]?.children[0]?.values).toEqual({ label: "Z" });
    tree = removeItem(tree, child.id);
    expect(countItems(tree)).toBe(1);
  });

  test("structureIssues reports what a bad drop would break", () => {
    expect(structureIssues(MEGA, [item("top", [item("column")])])).toEqual([]);
    const issues = structureIssues(MEGA, [item("column"), item("top", [item("link")])]);
    expect(issues.length).toBe(2);
  });
});

describe("saving", () => {
  test("values are cleaned per node, nested too", () => {
    const child: EditorItem = {
      id: "c",
      node: "entry",
      values: { label: "", link: { href: " /x " } },
      children: [],
    };
    const tree: EditorItem[] = [
      { id: "p", node: "entry", values: { label: "P", stray: 1 }, children: [child] },
    ];
    expect(toSavedItems(MENU, tree)).toEqual([
      {
        id: "p",
        node: "entry",
        values: { label: "P" },
        children: [{ id: "c", node: "entry", values: { link: { href: "/x" } } }],
      },
    ]);
  });

  test("replaceLevel swaps one level", () => {
    const a = item("entry");
    const b = item("entry");
    const p = item("entry", [a]);
    expect(replaceLevel([p], p.id, [b, a])[0]?.children.map((c) => c.id)).toEqual([b.id, a.id]);
    expect(replaceLevel([p], null, [b]).map((c) => c.id)).toEqual([b.id]);
  });

  test("a drag across an empty child zone never duplicates the entry (PR #1121)", () => {
    // [Blog, Docs > Guides]; drag Docs up across Blog's empty child zone.
    const guides = item("entry");
    const docs = item("entry", [guides]);
    const blog = item("entry");
    let tree = [blog, docs];
    // 1. Blog's child zone takes Docs while the pointer crosses it.
    tree = replaceLevel(tree, blog.id, [docs]);
    const staleBlog = tree[0] as EditorItem; // the top zone's copy: Docs inside
    // 2. The top zone reports from that stale copy, Docs first …
    tree = replaceLevel(tree, null, [docs, staleBlog]);
    // 3. … and Blog's child zone lets Docs go.
    tree = replaceLevel(tree, blog.id, []);
    const ids: string[] = [];
    const walk = (level: readonly EditorItem[]) => {
      for (const it of level) {
        ids.push(it.id);
        walk(it.children);
      }
    };
    walk(tree);
    expect(ids).toEqual([docs.id, guides.id, blog.id]);
    expect(tree.map((t) => t.id)).toEqual([docs.id, blog.id]);
    expect(tree[0]?.children.map((c) => c.id)).toEqual([guides.id]);
  });
});
