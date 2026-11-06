// SPDX-License-Identifier: MPL-2.0

/**
 * #1169 — the browser side of a long thread. The real bake of an in-memory
 * thread goes into a small DOM, the real `runtime.js` runs over it, and its
 * calls reach the real `list_approved`: a visitor who keeps clicking must end
 * up with every approved comment, each once, newest first.
 */

import { describe, expect, it } from "bun:test";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";
import { THREAD_RUNTIME_JS } from "./runtime.js";

interface Row {
  id: string;
  publicRowId: string;
  pageId: string;
  parentId: null;
  authorName: string;
  content: string;
  status: "approved";
  submittedAt: string;
  archivedAt: string;
}

const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const BAKED_AT = "2026-06-01T00:00:00.000Z";

/** Row `n`, approved `n` minutes into the year. */
function row(n: number, content = `Comment ${n}`): Row {
  const at = new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    id,
    publicRowId: id,
    pageId: PAGE_ID,
    parentId: null,
    authorName: `Author ${n}`,
    content,
    status: "approved",
    submittedAt: at,
    archivedAt: `${at.slice(0, -1)}000Z`,
  };
}

/** `comment_archive.list_for_page` and `.stats_many` over `rows`, as the real ops behave. */
function contextOver(rows: readonly Row[]): PluginContextTier1 {
  const newestFirst = [...rows].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  const call = async (op: string, input: Record<string, unknown>) => {
    if (op === "comment_archive.stats_many") {
      return { stats: [{ pageId: PAGE_ID, approved: rows.length, lastArchivedAt: "x" }] };
    }
    const { since, before, limit } = input as {
      since?: string;
      before?: { archivedAt: string };
      limit: number;
    };
    const matching = newestFirst.filter(
      (r) => (!since || r.archivedAt > since) && (!before || r.archivedAt < before.archivedAt),
    );
    const comments = matching.slice(0, limit);
    const last = comments[comments.length - 1];
    return {
      comments,
      nextCursor:
        matching.length > limit && last ? { archivedAt: last.archivedAt, id: last.id } : null,
    };
  };
  return { cms: { call } } as unknown as PluginContextTier1;
}

/** The little of the DOM the runtime touches. */
class El {
  attrs = new Map<string, string>();
  children: El[] = [];
  parent: El | null = null;
  className = "";
  text = "";
  type = "";
  disabled = false;
  listener: (() => void) | null = null;

  constructor(readonly tag: string) {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  appendChild(child: El): void {
    child.parent = this;
    this.children.push(child);
  }
  insertBefore(child: El, ref: El | undefined): void {
    child.parent = this;
    this.children.splice(ref ? this.children.indexOf(ref) : 0, 0, child);
  }
  get firstChild(): El | undefined {
    return this.children[0];
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get textContent(): string {
    return this.text;
  }
  addEventListener(_event: string, fn: () => void): void {
    this.listener = fn;
  }
  private walk(): El[] {
    return this.children.flatMap((c) => [c, ...c.walk()]);
  }
  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): El[] {
    const name = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    if (!name) throw new Error(`unsupported selector ${selector}`);
    return this.walk().filter((e) => e.attrs.has(name));
  }
}

/** The region as the plugin pass writes it, from the bake's real HTML. */
function regionFrom(html: string, bakedAt: string | null): El {
  const region = new El("div");
  region.setAttribute("data-page-id", PAGE_ID);
  if (bakedAt) region.setAttribute("data-baked-at", bakedAt);
  const thread = new El("div");
  thread.setAttribute("data-comment-thread", "");
  if (html.includes("data-comment-thread")) region.appendChild(thread);
  for (const m of html.matchAll(/data-comment-id="([^"]+)"/g)) {
    const article = new El("article");
    article.setAttribute("data-comment-id", m[1] as string);
    thread.appendChild(article);
  }
  const cursor = /data-cursor="([^"]+)"/.exec(html)?.[1];
  if (cursor) {
    const line = new El("p");
    line.setAttribute("data-older-comments", "");
    line.setAttribute("data-cursor", cursor.replaceAll("&quot;", '"'));
    region.appendChild(line);
  }
  return region;
}

interface Visit {
  region: El;
  warnings: unknown[][];
  calls: Record<string, unknown>[];
  /** Thread order: the comment ids a visitor sees, top to bottom. */
  ids: () => string[];
  button: () => El | undefined;
  settle: () => Promise<void>;
  /** Everything a click on the page's button would do; a disabled one does nothing. */
  click: () => void;
  /** The browser finishing the deferred scripts. */
  domReady: () => void;
}

/** Run the shipped `runtime.js` over `region`, its reads served by `rows`. */
async function visit(
  region: El,
  rows: readonly Row[],
  opts: {
    failReads?: () => boolean;
    consentDecision?: string;
    /** Stay before DOMContentLoaded until the test calls `domReady`. */
    holdDomReady?: boolean;
    /** Answers wait for this, in call order, while it is set. */
    gate?: { release: Promise<void> } | undefined;
    window?: Record<string, unknown>;
  } = {},
): Promise<Visit & { headers: Record<string, string>[] }> {
  const calls: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const warnings: unknown[][] = [];
  const list = plugin.operations.list_approved;
  if (!list) throw new Error("list_approved missing");
  const fetchStub = async (
    url: string,
    init: { body: string; headers: Record<string, string> },
  ) => {
    expect(url).toBe("/api/plugin/comments/list_approved");
    headers.push(init.headers);
    if (opts.failReads?.()) throw new Error("offline");
    const args = JSON.parse(init.body) as Record<string, unknown>;
    calls.push(args);
    if (opts.gate) await opts.gate.release;
    const data = await list(contextOver(rows), args);
    return { json: async () => ({ ok: true, data }) };
  };
  // A deferred script runs after parsing and before DOMContentLoaded.
  const ready: (() => void)[] = [];
  const doc = {
    readyState: "interactive",
    querySelectorAll: () => [region],
    createElement: (tag: string) => new El(tag),
    addEventListener: (event: string, fn: () => void) => {
      if (event === "DOMContentLoaded") ready.push(fn);
    },
  };
  const win = opts.window ?? {
    ...(opts.consentDecision
      ? { caeloConsent: { decisionHeader: () => opts.consentDecision } }
      : {}),
    addEventListener: () => undefined,
  };
  const assets = plugin.buildAssets?.({} as PluginContextTier1, { pageIds: [] }) as Record<
    string,
    string
  >;
  new Function("document", "window", "fetch", "console", assets["runtime.js"] as string)(
    doc,
    win,
    fetchStub,
    { warn: (...args: unknown[]) => warnings.push(args) },
  );
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const domReady = () => {
    for (const fn of ready.splice(0)) fn();
  };
  if (!opts.holdDomReady) domReady();
  await settle();
  const ids = () =>
    (region.querySelector("[data-comment-thread]") as El).children.map(
      (c) => c.getAttribute("data-comment-id") as string,
    );
  const button = () => region.children.find((c) => c.tag === "button");
  const click = () => {
    const b = button();
    if (b && !b.disabled) b.listener?.();
  };
  return { region, warnings, calls, headers, ids, button, settle, click, domReady };
}

async function clickUntilGone(v: Visit): Promise<number> {
  let clicks = 0;
  while (v.button()) {
    v.click();
    await v.settle();
    clicks += 1;
    if (clicks > 100) throw new Error("the button never went away");
  }
  return clicks;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => row(from + i));

async function bake(rows: readonly Row[]): Promise<string> {
  const render = plugin.staticRender;
  if (!render) throw new Error("staticRender missing");
  return (await render(contextOver(rows), {
    pageId: PAGE_ID,
    pageUrlStyle: "directory",
  })) as string;
}

describe("the baked thread in the browser (#1169)", () => {
  it("reaches every comment of a 230-comment thread, each once, newest first", async () => {
    const rows = range(1, 230);
    const html = await bake(rows);
    expect([...html.matchAll(/<article /g)]).toHaveLength(50);
    const v = await visit(regionFrom(html, BAKED_AT), rows);
    expect(v.ids()).toHaveLength(50);
    expect(v.calls).toEqual([{ pageId: PAGE_ID, since: BAKED_AT }]);
    expect(await clickUntilGone(v)).toBe(4);
    expect(v.ids()).toEqual([...rows].reverse().map((r) => r.publicRowId));
    // Nothing left to promise once the whole thread is on the page.
    expect(v.region.querySelector("[data-older-comments]")).toBeNull();
  });

  it("puts what was approved after the bake on top, newest first, without repeats", async () => {
    const baked = range(1, 60);
    const later = [...baked, row(61), row(62)];
    // A comment read by the bake AND archived after `data-baked-at` is in both.
    const bakedAt = baked[58]?.archivedAt ?? "";
    const v = await visit(regionFrom(await bake(baked), bakedAt), later);
    const ids = v.ids();
    expect(ids.slice(0, 3)).toEqual([row(62).id, row(61).id, row(60).id]);
    expect(new Set(ids).size).toBe(ids.length);
    await clickUntilGone(v);
    expect(v.ids()).toEqual([...later].reverse().map((r) => r.publicRowId));
  });

  it("adds no button to a thread the bake holds whole", async () => {
    const rows = range(1, 3);
    const html = await bake(rows);
    expect(html).not.toContain("data-older-comments");
    const v = await visit(regionFrom(html, BAKED_AT), rows);
    expect(v.button()).toBeUndefined();
    expect(v.ids()).toEqual([row(3).id, row(2).id, row(1).id]);
  });

  it("reads the thread from the top when a bake fell a page or more behind", async () => {
    const baked = range(1, 60);
    const all = range(1, 200);
    const bakedAt = baked[59]?.archivedAt ?? "";
    const v = await visit(regionFrom(await bake(baked), bakedAt), all);
    expect(v.calls).toEqual([{ pageId: PAGE_ID, since: bakedAt }, { pageId: PAGE_ID }]);
    await clickUntilGone(v);
    expect(v.ids()).toEqual([...all].reverse().map((r) => r.publicRowId));
  });

  it("fills a placeholder nothing baked into", async () => {
    const rows = range(1, 70);
    const v = await visit(regionFrom("", null), rows);
    expect(v.calls).toEqual([{ pageId: PAGE_ID }]);
    await clickUntilGone(v);
    expect(v.ids()).toEqual([...rows].reverse().map((r) => r.publicRowId));
  });

  it("keeps the button usable after a failed read", async () => {
    const rows = range(1, 70);
    let offline = false;
    const v = await visit(regionFrom(await bake(rows), BAKED_AT), rows, {
      failReads: () => offline,
    });
    offline = true;
    v.click();
    await v.settle();
    expect(v.warnings).toHaveLength(1);
    expect(v.button()?.disabled).toBe(false);
    offline = false;
    await clickUntilGone(v);
    expect(v.ids()).toHaveLength(70);
  });

  it("keeps the button shut until the first read settled, so no page skips comments", async () => {
    const baked = range(1, 180);
    const all = range(1, 400);
    const bakedAt = baked[179]?.archivedAt ?? "";
    const { promise: release, resolve: open } = Promise.withResolvers<void>();
    const v = await visit(regionFrom(await bake(baked), bakedAt), all, { gate: { release } });
    expect(v.button()?.disabled).toBe(true);
    v.click();
    await v.settle();
    expect(v.calls).toEqual([{ pageId: PAGE_ID, since: bakedAt }]);
    open();
    await v.settle();
    expect(v.button()?.disabled).toBe(false);
    await clickUntilGone(v);
    expect(v.ids()).toEqual([...all].reverse().map((r) => r.publicRowId));
  });

  it("opens the button when the first read fails: the bake's cursor is still good", async () => {
    const rows = range(1, 70);
    let offline = true;
    const v = await visit(regionFrom(await bake(rows), BAKED_AT), rows, {
      failReads: () => offline,
    });
    expect(v.warnings).toHaveLength(1);
    expect(v.button()?.disabled).toBe(false);
    offline = false;
    await clickUntilGone(v);
    expect(v.ids()).toHaveLength(70);
  });

  it("reads nothing before the deferred scripts ran, so a consent provider after it is seen", async () => {
    // `comments` sorts before `consent-manager`, so this file runs first.
    const rows = range(1, 3);
    const win: Record<string, unknown> = { addEventListener: () => undefined };
    const v = await visit(regionFrom(await bake(rows), BAKED_AT), rows, {
      holdDomReady: true,
      window: win,
    });
    expect(v.calls).toEqual([]);
    win.caeloConsent = { decisionHeader: () => "v=1; granted=analytics" };
    v.domReady();
    await v.settle();
    expect(v.headers[0]?.["x-caelo-consent"]).toBe("v=1; granted=analytics");
  });

  it("works on a site without a consent provider: no header, and the read still goes out", async () => {
    const rows = range(1, 3);
    const v = await visit(regionFrom(await bake(rows), BAKED_AT), rows);
    expect(v.calls).toHaveLength(1);
    expect(v.headers[0]?.["x-caelo-consent"]).toBeUndefined();
  });

  it("states the visitor's consent decision on its reads", async () => {
    const rows = range(1, 3);
    const v = await visit(regionFrom(await bake(rows), BAKED_AT), rows, {
      consentDecision: "v=1; granted=analytics",
    });
    expect(v.headers[0]?.["x-caelo-consent"]).toBe("v=1; granted=analytics");
  });

  it("renders visitor text as text, never as markup", async () => {
    const evil = row(61, '<img src=x onerror="alert(1)">');
    const rows = [...range(1, 60), evil];
    const v = await visit(regionFrom(await bake(range(1, 60)), row(60).archivedAt), rows);
    const thread = v.region.querySelector("[data-comment-thread]") as El;
    const body = thread.children[0]?.children[1];
    expect(body?.textContent).toBe(evil.content);
    expect(body?.children).toEqual([]);
    expect(THREAD_RUNTIME_JS).not.toContain("innerHTML");
  });
});

describe("the bake's markup (#1169)", () => {
  it("escapes visitor text and carries a parseable cursor", async () => {
    const rows = [...range(1, 60), row(61, '<script>alert("x")</script>')];
    const html = await bake(rows);
    expect(html).not.toContain("<script>");
    expect(html).toContain("Showing the newest 50 of 61 comments.");
    const raw = /data-cursor="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(raw).not.toContain('"');
    expect(JSON.parse(raw.replaceAll("&quot;", '"'))).toEqual({
      archivedAt: row(12).archivedAt,
      id: row(12).id,
    });
  });

  it("declares the visitor read with a rate limit and bounded input", () => {
    const op = plugin.publicOperations?.find((o) => o.name === "list_approved");
    expect(op?.rateLimit).toEqual({ max: 60, windowSeconds: 60 });
    expect(op?.captcha).toBe("none");
    const bad = op?.input.safeParse({ pageId: PAGE_ID, before: { archivedAt: "x", id: "y" } });
    expect(bad?.success).toBe(false);
    const big = op?.input.safeParse({ pageId: PAGE_ID, limit: 100000 });
    expect(big?.success).toBe(false);
  });
});
