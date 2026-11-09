// SPDX-License-Identifier: MPL-2.0

/**
 * #1169 / #1511 — the browser side of the comments plugin. The real bake of
 * an in-memory thread is spliced into the comments section the skill
 * teaches, the real `runtime.js` runs over it, and its calls reach the real
 * `list_approved` and `submit`. A visitor who keeps clicking ends up with
 * every approved comment, each once, newest first; a visitor who writes a
 * comment sends it with its proof-of-work and reads the site's own words.
 */

import { describe, expect, it } from "bun:test";
import { HONEYPOT_FIELD_NAME } from "@caelo-cms/plugin-component-kit";
import type { PluginContextTier1 } from "@caelo-cms/plugin-sdk";
import plugin from "./index.js";
import { COMMENT_DATE_OPTIONS } from "./render.js";
import { THREAD_RUNTIME_JS } from "./runtime.js";
import { COMMENTS_SKILLS } from "./skills.js";
import { El, fakeDocument, parseInto } from "./test-dom.js";

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
    const { since, before, limit, commentId } = input as {
      since?: string;
      before?: { archivedAt: string };
      limit: number;
      commentId?: string;
    };
    const matching = newestFirst.filter(
      (r) =>
        (!since || r.archivedAt > since) &&
        (!before || r.archivedAt < before.archivedAt) &&
        (!commentId || r.id === commentId),
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

/**
 * The section the skill teaches, as the build renders it: site texts
 * resolved (`T:<key>`), `{{page.id}}` the page's id.
 */
function skillSection(): string {
  const body = COMMENTS_SKILLS[0]?.body ?? "";
  const markup = body
    .split("\n")
    .filter((l) => l.startsWith("   <"))
    .map((l) => l.trim())
    .join("");
  expect(markup).toContain("data-comments");
  return markup
    .replaceAll("{{page.id}}", PAGE_ID)
    .replace(/\{\{site_text\.([a-z_]+)\}\}/g, (_m, key: string) => `T:${key}`);
}

/** A page with the section, its placeholder filled the way the plugin pass fills it. */
function pageWith(bake: string | null, bakedAt: string | null, section = skillSection()): El {
  const placeholder = `<div data-caelo-plugin="comments" data-page-id="${PAGE_ID}"></div>`;
  expect(section).toContain(placeholder);
  const region =
    bake === null
      ? placeholder
      : `<div data-caelo-plugin="comments" data-page-id="${PAGE_ID}"${bakedAt ? ` data-baked-at="${bakedAt}"` : ""}>${bake}</div>`;
  return parseInto(new El("html"), `<body>${section.replace(placeholder, region)}</body>`);
}

interface Visit {
  root: El;
  warnings: unknown[][];
  calls: Record<string, unknown>[];
  submits: Record<string, unknown>[];
  headers: Record<string, string>[];
  /** Thread order: the comment ids a visitor sees, top to bottom. */
  ids: () => string[];
  button: () => El;
  form: () => El;
  status: () => El;
  settle: () => Promise<void>;
  /** Everything a click on the button would do; a disabled or hidden one does nothing. */
  click: () => void;
  /** The browser finishing the deferred scripts. */
  domReady: () => void;
}

/** Run the shipped `runtime.js` over `root`, its calls served by `rows`. */
async function visit(
  root: El,
  rows: readonly Row[],
  opts: {
    lang?: string;
    failReads?: () => boolean;
    consentDecision?: string;
    holdDomReady?: boolean;
    gate?: { release: Promise<void> } | undefined;
    window?: Record<string, unknown>;
    /** The gateway's answer to a challenge request: a target prefix, or 204 (captcha off). */
    captcha?: { target: string } | "off";
    /** What the gateway answers a submit with. */
    submitAnswer?: () => { ok: boolean; data?: unknown; error?: { kind: string } };
  } = {},
): Promise<Visit> {
  root.setAttribute("lang", opts.lang ?? "en");
  const calls: Record<string, unknown>[] = [];
  const submits: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const warnings: unknown[][] = [];
  const list = plugin.operations.list_approved;
  if (!list) throw new Error("list_approved missing");
  const captcha = opts.captcha ?? { target: "0" };
  const fetchStub = async (
    url: string,
    init: { body?: string; headers: Record<string, string> },
  ) => {
    headers.push(init.headers);
    if (url === "/api/captcha/challenge") {
      if (captcha === "off") return { status: 204, ok: true, json: async () => ({}) };
      return {
        status: 200,
        ok: true,
        json: async () => ({ ok: true, data: { challenge: "ch-1", target: captcha.target } }),
      };
    }
    const args = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    if (url === "/api/plugin/comments/submit") {
      submits.push(args);
      return {
        json: async () => opts.submitAnswer?.() ?? { ok: true, data: { status: "pending" } },
      };
    }
    expect(url).toBe("/api/plugin/comments/list_approved");
    if (opts.failReads?.()) throw new Error("offline");
    calls.push(args);
    if (opts.gate) await opts.gate.release;
    const data = await list(contextOver(rows), args);
    return { json: async () => ({ ok: true, data }) };
  };
  const ready: (() => void)[] = [];
  const doc = fakeDocument(root, ready);
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
    for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  const domReady = () => {
    for (const fn of ready.splice(0)) fn();
  };
  if (!opts.holdDomReady) domReady();
  await settle();
  const one = (selector: string) => {
    const el = root.querySelector(selector);
    if (!el) throw new Error(`no ${selector}`);
    return el;
  };
  return {
    root,
    warnings,
    calls,
    submits,
    headers,
    ids: () =>
      root
        .querySelectorAll("[data-comment-id]")
        .map((c) => c.getAttribute("data-comment-id") as string),
    button: () => one("[data-comment-older]"),
    form: () => one("form[data-comment-form]"),
    status: () => one("[data-comment-status]"),
    settle,
    click: () => {
      const b = root.querySelector("[data-comment-older]");
      if (b && !b.hidden) b.click();
    },
    domReady,
  };
}

async function clickUntilGone(v: Visit): Promise<number> {
  let clicks = 0;
  while (!v.button().hidden) {
    v.click();
    await v.settle();
    clicks += 1;
    if (clicks > 100) throw new Error("the button never went away");
  }
  return clicks;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => row(from + i));

async function bake(rows: readonly Row[], lang = "en"): Promise<string> {
  const render = plugin.staticRender;
  if (!render) throw new Error("staticRender missing");
  return (await render(contextOver(rows), {
    pageId: PAGE_ID,
    pageUrlStyle: "directory",
    lang,
  })) as string;
}

describe("the baked thread in the browser (#1169)", () => {
  it("reaches every comment of a 230-comment thread, each once, newest first", async () => {
    const rows = range(1, 230);
    const html = await bake(rows);
    expect([...html.matchAll(/<article /g)]).toHaveLength(50);
    const v = await visit(pageWith(html, BAKED_AT), rows);
    expect(v.ids()).toHaveLength(50);
    expect(v.calls).toEqual([{ pageId: PAGE_ID, since: BAKED_AT }]);
    expect(v.button().hidden).toBe(false);
    expect(await clickUntilGone(v)).toBe(4);
    expect(v.ids()).toEqual([...rows].reverse().map((r) => r.publicRowId));
    expect(v.warnings).toEqual([]);
  });

  it("puts what was approved after the bake on top, newest first, without repeats", async () => {
    const baked = range(1, 60);
    const later = [...baked, row(61), row(62)];
    // A comment read by the bake AND archived after `data-baked-at` is in both.
    const bakedAt = baked[58]?.archivedAt ?? "";
    const v = await visit(pageWith(await bake(baked), bakedAt), later);
    const ids = v.ids();
    expect(ids.slice(0, 3)).toEqual([row(62).id, row(61).id, row(60).id]);
    expect(new Set(ids).size).toBe(ids.length);
    await clickUntilGone(v);
    expect(v.ids()).toEqual([...later].reverse().map((r) => r.publicRowId));
  });

  it("keeps the button hidden on a thread the bake holds whole", async () => {
    const rows = range(1, 3);
    const html = await bake(rows);
    expect(html).not.toContain("data-cursor");
    const v = await visit(pageWith(html, BAKED_AT), rows);
    expect(v.button().hidden).toBe(true);
    expect(v.ids()).toEqual([row(3).id, row(2).id, row(1).id]);
  });

  it("reads the thread from the top when a bake fell a page or more behind", async () => {
    const baked = range(1, 60);
    const all = range(1, 200);
    const bakedAt = baked[59]?.archivedAt ?? "";
    const v = await visit(pageWith(await bake(baked), bakedAt), all);
    expect(v.calls).toEqual([{ pageId: PAGE_ID, since: bakedAt }, { pageId: PAGE_ID }]);
    await clickUntilGone(v);
    expect(v.ids()).toEqual([...all].reverse().map((r) => r.publicRowId));
  });

  it("fills a placeholder nothing baked into", async () => {
    const rows = range(1, 70);
    const v = await visit(pageWith(null, null), rows);
    expect(v.calls).toEqual([{ pageId: PAGE_ID }]);
    await clickUntilGone(v);
    expect(v.ids()).toEqual([...rows].reverse().map((r) => r.publicRowId));
  });

  it("keeps the button usable after a failed read", async () => {
    const rows = range(1, 70);
    let offline = false;
    const v = await visit(pageWith(await bake(rows), BAKED_AT), rows, {
      failReads: () => offline,
    });
    offline = true;
    v.click();
    await v.settle();
    expect(v.warnings).toHaveLength(1);
    expect(v.button().disabled).toBe(false);
    offline = false;
    await clickUntilGone(v);
    expect(v.ids()).toHaveLength(70);
  });

  it("keeps the button shut until the first read settled, so no page skips comments", async () => {
    const baked = range(1, 180);
    const all = range(1, 400);
    const bakedAt = baked[179]?.archivedAt ?? "";
    const { promise: release, resolve: open } = Promise.withResolvers<void>();
    const v = await visit(pageWith(await bake(baked), bakedAt), all, { gate: { release } });
    expect(v.button().disabled).toBe(true);
    v.click();
    await v.settle();
    expect(v.calls).toEqual([{ pageId: PAGE_ID, since: bakedAt }]);
    open();
    await v.settle();
    expect(v.button().disabled).toBe(false);
    await clickUntilGone(v);
    expect(v.ids()).toEqual([...all].reverse().map((r) => r.publicRowId));
  });

  it("opens the button when the first read fails: the bake's cursor is still good", async () => {
    const rows = range(1, 70);
    let offline = true;
    const v = await visit(pageWith(await bake(rows), BAKED_AT), rows, {
      failReads: () => offline,
    });
    expect(v.warnings).toHaveLength(1);
    expect(v.button().disabled).toBe(false);
    offline = false;
    await clickUntilGone(v);
    expect(v.ids()).toHaveLength(70);
  });

  it("reads nothing before the deferred scripts ran, so a consent provider after it is seen", async () => {
    // `comments` sorts before `consent-manager`, so this file runs first.
    const rows = range(1, 3);
    const win: Record<string, unknown> = { addEventListener: () => undefined };
    const v = await visit(pageWith(await bake(rows), BAKED_AT), rows, {
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
    const v = await visit(pageWith(await bake(rows), BAKED_AT), rows);
    expect(v.calls).toHaveLength(1);
    expect(v.headers[0]?.["x-caelo-consent"]).toBeUndefined();
  });

  it("states the visitor's consent decision on its reads", async () => {
    const rows = range(1, 3);
    const v = await visit(pageWith(await bake(rows), BAKED_AT), rows, {
      consentDecision: "v=1; granted=analytics",
    });
    expect(v.headers[0]?.["x-caelo-consent"]).toBe("v=1; granted=analytics");
  });

  it("renders visitor text as text, never as markup", async () => {
    const evil = row(61, '<img src=x onerror="alert(1)">');
    const rows = [...range(1, 60), evil];
    const v = await visit(pageWith(await bake(range(1, 60)), row(60).archivedAt), rows);
    const thread = v.root.querySelector("[data-comment-thread]") as El;
    const article = thread.children[0];
    expect(article?.getAttribute("data-comment-id")).toBe(evil.id);
    const body = article?.children[1];
    expect(body?.className).toBe("body");
    expect(body?.textContent).toBe(evil.content);
    expect(body?.children).toEqual([]);
    expect(THREAD_RUNTIME_JS).not.toContain("innerHTML");
  });
});

describe("dates in the page's language (#1511)", () => {
  it("bakes German dates on a German page, in a <time> crawlers read", async () => {
    const html = await bake([row(1)], "de");
    expect(html).toContain('<time datetime="2026-01-01T00:01:00.000Z">1. Januar 2026</time>');
    expect(await bake([row(1)], "en")).toContain(">January 1, 2026</time>");
  });

  it("formats a comment that arrives later exactly like the baked ones", async () => {
    const later = row(4000);
    const v = await visit(
      pageWith(await bake([row(1)], "de"), row(1).archivedAt),
      [row(1), later],
      {
        lang: "de",
      },
    );
    const thread = v.root.querySelector("[data-comment-thread]") as El;
    const time = thread.children[0]?.querySelector("time");
    const expected = new Intl.DateTimeFormat("de", COMMENT_DATE_OPTIONS).format(
      new Date(later.submittedAt),
    );
    expect(time?.textContent).toBe(expected);
    expect(time?.getAttribute("datetime")).toBe(later.submittedAt);
    const baked = thread.children[1]?.querySelector("time");
    expect(baked?.textContent).toBe("1. Januar 2026");
  });

  it("refuses a page language Intl cannot format instead of guessing one", async () => {
    await expect(bake([row(1)], "not a tag")).rejects.toThrow(/page language/);
  });
});

describe("the comment form (#1511)", () => {
  it("binds to the section the skill teaches, without a single warning", async () => {
    const v = await visit(pageWith(await bake([row(1)]), BAKED_AT), [row(1)]);
    expect(v.warnings).toEqual([]);
    expect(v.form().hidden).toBe(false);
    const trap = v.form().querySelector(`[name="${HONEYPOT_FIELD_NAME}"]`);
    expect(trap?.getAttribute("tabindex")).toBe("-1");
    expect(v.form().querySelector('[name="authorName"]')?.maxLength).toBe(80);
    expect(v.form().querySelector('[name="content"]')?.maxLength).toBe(4000);
  });

  it("sends name, comment, honeypot and a proof solved for comments.submit, then says the site's words", async () => {
    const v = await visit(pageWith(await bake([row(1)]), BAKED_AT), [row(1)]);
    const form = v.form();
    (form.querySelector('[name="authorName"]') as El).value = "Ann";
    (form.querySelector('[name="content"]') as El).value = "Hallo";
    expect(form.dispatch("submit")).toBe(true);
    await v.settle();
    expect(v.submits).toHaveLength(1);
    const sent = v.submits[0] as Record<string, unknown> & {
      _caelo_captcha: { challenge: string; nonce: string };
    };
    expect(sent).toMatchObject({ pageId: PAGE_ID, authorName: "Ann", content: "Hallo" });
    expect(sent[HONEYPOT_FIELD_NAME]).toBe("");
    // The gateway's preimage (api-gateway `powPreimage`): challenge|slug.operation|nonce.
    const digest = new Bun.CryptoHasher("sha256")
      .update(`${sent._caelo_captcha.challenge}|comments.submit|${sent._caelo_captcha.nonce}`)
      .digest("hex");
    expect(digest.startsWith("0")).toBe(true);
    // Whatever the runtime sends, `submit`'s declared contract accepts.
    const contract = plugin.publicOperations?.find((o) => o.name === "submit")?.input;
    const { _caelo_captcha: _proof, ...body } = sent;
    expect(contract?.safeParse(body).success).toBe(true);
    expect(v.status().textContent).toBe("T:comments_sent");
    expect(v.status().getAttribute("data-state")).toBe("sent");
    expect((form.querySelector('[name="content"]') as El).value).toBe("");
    expect((form.querySelector('[type="submit"]') as El).disabled).toBe(false);
  });

  it("sends no proof when the Owner turned the captcha off", async () => {
    const v = await visit(pageWith(await bake([row(1)]), BAKED_AT), [row(1)], {
      captcha: "off",
    });
    v.form().dispatch("submit");
    await v.settle();
    expect(v.submits[0]).not.toHaveProperty("_caelo_captcha");
  });

  it("tells the visitor in the site's words when the gateway refuses", async () => {
    const v = await visit(pageWith(await bake([row(1)]), BAKED_AT), [row(1)], {
      submitAnswer: () => ({ ok: false, error: { kind: "Rejected" } }),
    });
    v.form().dispatch("submit");
    await v.settle();
    expect(v.status().textContent).toBe("T:comments_error");
    expect(v.status().getAttribute("data-state")).toBe("error");
    expect(String(v.warnings[0]?.[0])).toContain("Rejected");
  });

  it("does not send a form the browser finds invalid", async () => {
    const v = await visit(pageWith(await bake([row(1)]), BAKED_AT), [row(1)]);
    v.form().valid = false;
    expect(v.form().dispatch("submit")).toBe(true);
    await v.settle();
    expect(v.submits).toEqual([]);
  });

  it("names every missing part of the contract, and never lets the browser send the form", async () => {
    const broken = skillSection()
      .replace(/ data-sent-text="[^"]*"/, "")
      .replace(/<p data-comment-status[^>]*><\/p>/, "");
    const v = await visit(pageWith(null, null, broken), []);
    const text = v.warnings.map((w) => String(w[0])).join("\n");
    expect(text).toContain("data-sent-text");
    expect(text).toContain("[data-comment-status]");
    expect(v.form().hidden).toBe(true);
    expect(v.form().dispatch("submit")).toBe(true);
    await v.settle();
    expect(v.submits).toEqual([]);
  });

  it("warns when the placeholder sits in no comments section", async () => {
    const bare = parseInto(
      new El("html"),
      `<body><div data-caelo-plugin="comments" data-page-id="${PAGE_ID}"></div></body>`,
    );
    const v = await visit(bare, range(1, 70));
    expect(String(v.warnings[0]?.[0])).toContain("[data-comments]");
    expect(String(v.warnings[1]?.[0])).toContain("[data-comment-older]");
    expect(v.ids()).toHaveLength(50);
  });
});

describe("the bake's markup (#1169)", () => {
  it("escapes visitor text and carries a parseable cursor and the total", async () => {
    const evil = { ...row(61, '<script>alert("x")</script>'), authorName: '"><b onmouseover=x>' };
    const html = await bake([...range(1, 60), evil]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b ");
    expect(html).toContain('data-total="61"');
    expect(html).not.toMatch(/Showing|comments\./);
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

  it("ships behaviour CSS only: the honeypot off-screen, hidden parts hidden", () => {
    const assets = plugin.buildAssets?.({} as PluginContextTier1, { pageIds: [] }) as Record<
      string,
      string
    >;
    const css = assets["runtime.css"] ?? "";
    expect(css).toContain(`input[name="${HONEYPOT_FIELD_NAME}"]`);
    expect(css).toContain("[data-comment-older][hidden]");
    expect(css).not.toMatch(/color|font|border|background/);
    // Inlined, not linked, below the 2 KB threshold (#1124).
    expect(css.length).toBeLessThan(2048);
  });
});
