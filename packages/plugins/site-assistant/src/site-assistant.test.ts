// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  checkAiChatOperations,
  manifestFromDefinition,
  pluginManifest,
  visitorVisibleLeaves,
} from "@caelo-cms/plugin-sdk";
import { clusterGaps, type FeedbackEvent, MIN_GAP_COUNT, questionWords } from "./gaps.js";
import plugin, {
  ANSWER_MARKUP,
  ASK_MARKUP,
  linkedPageId,
  SITE_TEXT_KEYS,
  testQuestionsOf,
  WIDGET_MARKUP,
} from "./index.js";
import { RUNTIME_JS } from "./runtime.js";
import {
  answerCardMode,
  answered,
  answerParts,
  answerStoreKey,
  appendTurn,
  checkQuestion,
  conversationFull,
  keepConversation,
  keptConversation,
  parseSse,
  searchQueryOf,
  sourceHref,
  type WidgetSource,
} from "./widget-logic.js";

const manifest = manifestFromDefinition(plugin);

describe("the site assistant's declaration", () => {
  it("is a valid manifest", () => {
    const r = pluginManifest.safeParse(manifest);
    expect(r.success ? [] : r.error.issues).toEqual([]);
  });

  it("converses with site-search's search and read only, and needs the visitor AI", () => {
    const [op] = manifest.aiChatOperations ?? [];
    expect(op?.tools).toEqual([
      { plugin: "site-search", operation: "search" },
      { plugin: "site-search", operation: "read" },
    ]);
    expect(manifest.requires).toEqual(["visitor-ai"]);
    expect(manifest.requiresPlugins).toEqual(["site-search"]);
    expect(manifest.requestedCapabilities).toContain("visitor_ai");
    // No write reaches the model: the conversation has no code operation of its name.
    expect(Object.keys(plugin.operations)).not.toContain(op?.name);
    const issues: string[] = [];
    checkAiChatOperations(manifest as never, Object.keys(plugin.operations), (_p, m) =>
      issues.push(m),
    );
    expect(issues).toEqual([]);
  });

  it("composes its prompt only from released, visitor-visible settings", () => {
    const visible = visitorVisibleLeaves(manifest.config ?? {}).map((l) => l.path);
    expect(visible.sort()).toEqual(
      ["assistant.handoff", "assistant.persona", "assistant.scope", "feedback.enabled"].sort(),
    );
    const [op] = manifest.aiChatOperations ?? [];
    expect(op?.prompt.fields).toEqual([
      "assistant.persona",
      "assistant.scope",
      "assistant.handoff",
    ]);
    // What visitors are told when it cannot help is the site's promise: approval-gated.
    const leaves = visitorVisibleLeaves(manifest.config ?? {});
    expect(leaves.find((l) => l.path === "assistant.handoff")?.field.gate).toBe("approval");
    expect(leaves.find((l) => l.path === "feedback.enabled")?.field.gate).toBe("approval");
  });

  it("keeps feedback only while it is on, without personal data in the question or the note", () => {
    const [op] = manifest.publicOperations ?? [];
    expect(op?.name).toBe("feedback");
    const run = op?.run as Record<string, unknown>;
    expect(run.onlyIf).toEqual({
      config: "feedback.enabled",
      equals: true,
      answer: { recorded: true },
    });
    expect(run.drop).toEqual({
      fields: ["question", "note"],
      patterns: ["email", "phone", "long-number"],
      answer: { recorded: true },
    });
    expect(run.honeypot).toEqual({
      field: "website",
      store: "nothing",
      answer: { recorded: true },
    });
    expect(manifest.tableKinds).toEqual({ feedback: "inbox" });
  });

  it("gives the AI the widget and answer-card markup with every text as a site text", () => {
    const all = `${WIDGET_MARKUP}\n${ANSWER_MARKUP}\n${ASK_MARKUP}`;
    for (const key of Object.keys(SITE_TEXT_KEYS)) expect(all).toContain(`{{site_text.${key}}}`);
    // Every key a markup names is a documented site text.
    for (const m of all.matchAll(/\{\{site_text\.([a-z_]+)\}\}/g))
      expect(Object.keys(SITE_TEXT_KEYS)).toContain(m[1] as string);
    expect(WIDGET_MARKUP).toContain('data-caelo-plugin="site-assistant"');
  });

  it("#1701 — both cards are the site's own markup, hidden until they answer, with the disclosure", () => {
    for (const card of [ANSWER_MARKUP, ASK_MARKUP]) {
      for (const contract of [
        "data-caelo-assistant-disclosure",
        "{{site_text.assistant_disclosure}}",
        "data-caelo-assistant-thread",
        "<template data-caelo-assistant-turn>",
        'data-field="question"',
        'data-field="answer"',
        'data-field="sources"',
        'data-rate="helpful"',
        "<template data-caelo-assistant-source>",
        "data-caelo-assistant-input",
        "data-caelo-assistant-new hidden",
        'data-text="handoff"',
        'data-caelo-plugin="site-assistant"',
      ])
        expect(card).toContain(contract);
      // No floating panel, no Web Component: neither is the widget.
      expect(card).not.toContain("data-caelo-assistant-open");
      expect(card).not.toContain("<script");
      // Several cards on a page: no fixed ids to collide.
      expect(card).not.toContain(" id=");
    }
    // The results page's card answers the query; its field waits for the follow-ups.
    expect(ANSWER_MARKUP).toMatch(/^<section data-caelo-assistant-answer="query" hidden>/);
    expect(ANSWER_MARKUP).toContain("<form data-caelo-assistant-ask hidden>");
    // The card for any page takes the visitor's own question at once.
    expect(ASK_MARKUP).toMatch(/^<section data-caelo-assistant-answer="ask" hidden>/);
    expect(ASK_MARKUP).toContain("<form data-caelo-assistant-ask>");
    expect(answerCardMode("query")).toBe("query");
    expect(answerCardMode(" Ask ")).toBe("ask");
  });

  it("#1701 — get_site_assistant_setup hands out the widget and both cards", async () => {
    const setup = (await (
      plugin.operations.setup as (c: unknown, a: unknown) => Promise<Record<string, unknown>>
    )({ config: { get: async () => ({}) } }, {})) as {
      widgetMarkup: string;
      answerMarkup: string;
      askMarkup: string;
    };
    expect(setup.widgetMarkup).toBe(WIDGET_MARKUP);
    expect(setup.answerMarkup).toBe(ANSWER_MARKUP);
    expect(setup.askMarkup).toBe(ASK_MARKUP);
  });
});

describe("the widget's logic (the code the browser runs)", () => {
  const src = (
    n: number,
    url: string,
    anchor: string | null = null,
    cited = true,
  ): WidgetSource => ({
    n,
    url,
    title: `Seite ${n}`,
    anchor,
    cited,
  });

  it("reads the event stream in pieces, skipping what is not JSON", () => {
    const a = parseSse('event: delta\ndata: {"text":"Das "}\n\nevent: delta\ndata: {"te');
    expect(a.events).toEqual([{ event: "delta", data: { text: "Das " } }]);
    const b = parseSse(`${a.rest}xt":"kostet"}\n\nevent: x\ndata: not json\n\n`);
    expect(b.events).toEqual([{ event: "delta", data: { text: "kostet" } }]);
    expect(b.rest).toBe("");
  });

  it("checks a question's length as the gateway does", () => {
    expect(checkQuestion("  Was kostet es?  ", 500)).toBe("Was kostet es?");
    expect(checkQuestion("   ", 500)).toBeNull();
    expect(checkQuestion("x".repeat(501), 500)).toBeNull();
  });

  it("keeps the signed turns in order and knows when the conversation is used up", () => {
    let h: string[] = [];
    h = appendTurn(h, "a.b");
    h = appendTurn(h, "not-signed");
    h = appendTurn(h, "c.d");
    expect(h).toEqual(["a.b", "c.d"]);
    expect(conversationFull(h, 2)).toBe(true);
    expect(conversationFull(h, 3)).toBe(false);
  });

  it("links a source only as a path on this site", () => {
    expect(sourceHref(src(1, "/preise/", "pakete"))).toBe("/preise/#pakete");
    expect(sourceHref(src(1, "/preise/", "bad anchor"))).toBe("/preise/");
    for (const url of [
      "//evil.example/x",
      "https://evil.example/",
      "javascript:alert(1)",
      '/a"onmouseover=x',
      "",
    ])
      expect(sourceHref(src(1, url))).toBeNull();
  });

  it("turns [n] into a link only to a source the gateway sent; the text stays text", () => {
    const parts = answerParts("Starter kostet 49 Euro [1]. Siehe [7] und <b>[x]</b>.", [
      src(1, "/preise/", "pakete"),
    ]);
    expect(parts).toEqual([
      { text: "Starter kostet 49 Euro " },
      { cite: 1, href: "/preise/#pakete", title: "Seite 1" },
      { text: ". Siehe [7] und <b>[x]</b>." },
    ]);
    // Built to backtrack, answered in linear time.
    const started = performance.now();
    answerParts(`${"[".repeat(50_000)}1`, [src(1, "/a/")]);
    answerParts("[1".repeat(30_000), [src(1, "/a/")]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("calls an answer without a cited source unanswered", () => {
    expect(answered([src(1, "/preise/")])).toBe(true);
    expect(answered([src(1, "/preise/", null, false)])).toBe(false);
    expect(answered([src(1, "https://evil.example/")])).toBe(false);
    expect(answered([])).toBe(false);
  });
});

describe("#1701 — the query the answer card asks", () => {
  it("reads the query as site-search does: #q= first, then ?q=", () => {
    expect(searchQueryOf("", "#q=Was+kostet+es%3F")).toEqual({
      query: "Was kostet es?",
      anchor: false,
    });
    expect(searchQueryOf("?q=Rabatte", "")).toEqual({ query: "Rabatte", anchor: false });
    expect(searchQueryOf("?q=alt", "#q=neu")).toEqual({ query: "neu", anchor: false });
    expect(searchQueryOf("", "#main")).toEqual({ query: "", anchor: true });
    expect(searchQueryOf("", "")).toEqual({ query: "", anchor: false });
  });
});

describe("#1701 — the cards' modes and kept conversations", () => {
  it("knows only the two modes: anything else asks nothing", () => {
    expect(answerCardMode("query")).toBe("query");
    expect(answerCardMode("ask")).toBe("ask");
    expect(answerCardMode("")).toBeNull();
    expect(answerCardMode(null)).toBeNull();
    expect(answerCardMode("chat")).toBeNull();
  });

  it("keeps each card's conversation apart: by page and by its id or place", () => {
    const keys = new Set([
      answerStoreKey("/produkt/", "", 0),
      answerStoreKey("/produkt/", "", 1),
      answerStoreKey("/kontakt/", "", 0),
      answerStoreKey("/produkt/", "sidebar", 0),
      answerStoreKey("/produkt/", "footer", 0),
    ]);
    expect(keys.size).toBe(5);
    // The same card on a reload: the same key.
    expect(answerStoreKey("/produkt/", "", 1)).toBe(answerStoreKey("/produkt/", "", 1));
    // An id may not pose as a place.
    expect(answerStoreKey("/p/", "n:0", 3)).not.toBe(answerStoreKey("/p/", "", 0));
  });

  it("shows a kept conversation again only for its language and query (review on #1742)", () => {
    const de = { lang: "de", query: "kosten", history: ["a.b"], messages: [{ q: "kosten" }] };
    const en = { lang: "en", query: "kosten", history: ["c.d"], messages: [{ q: "kosten" }] };
    const ask = { lang: "de", query: "", history: ["e.f"], messages: [{ q: "Was kostet es?" }] };
    const kept = [de, en, ask];
    expect(keptConversation(kept, "de", "kosten")).toBe(de);
    expect(keptConversation(kept, "en", "kosten")).toBe(en);
    expect(keptConversation(kept, "fr", "kosten")).toBeNull();
    expect(keptConversation(kept, "de", "versand")).toBeNull();
    expect(keptConversation(kept, "de", "")).toBe(ask);
    // A conversation without an answer is nothing to show.
    expect(keptConversation([{ ...de, messages: [] }], "de", "kosten")).toBeNull();
    expect(keptConversation(null, "de", "")).toBeNull();
  });

  it("keeps the conversations of earlier searches, the latest first, at most ten", () => {
    const conv = (query: string) => ({ lang: "de", query, history: [], messages: [{ q: query }] });
    let kept = keepConversation(null, conv("a"));
    kept = keepConversation(kept, conv("b"));
    // Back to A: A's conversation is still there.
    expect(keptConversation(kept, "de", "a")?.query).toBe("a");
    // Saving A again moves it to the front instead of adding a second one.
    kept = keepConversation(kept, { ...conv("a"), history: ["x.y"] });
    expect(kept.map((k) => k.query)).toEqual(["a", "b"]);
    expect(kept[0]?.history).toEqual(["x.y"]);
    for (let i = 0; i < 20; i++) kept = keepConversation(kept, conv(`q${i}`));
    expect(kept).toHaveLength(10);
    expect(kept[0]?.query).toBe("q19");
  });
});

describe("the browser script", () => {
  it("is valid JavaScript, ships the tested logic, and builds no markup from text", () => {
    expect(() => new Function(RUNTIME_JS)).not.toThrow();
    for (const name of [
      "parseSse",
      "answerParts",
      "sourceHref",
      "appendTurn",
      "checkQuestion",
      "searchQueryOf",
      "answerCardMode",
      "answerStoreKey",
      "keptConversation",
      "keepConversation",
    ])
      expect(RUNTIME_JS).toContain(`function ${name}(`);
    // #1701 — the answer card binds to the site's card, follows the query
    // and refuses to ask without the disclosure.
    expect(RUNTIME_JS).toContain('"[data-caelo-assistant-answer]"');
    expect(RUNTIME_JS).toContain('"hashchange"');
    expect(RUNTIME_JS).toContain('"disclosure-missing"');
    expect(RUNTIME_JS).not.toContain("innerHTML");
    expect(RUNTIME_JS).not.toContain("eval(");
    // The page's own credentials (the staging gate's cookie), never another origin's.
    expect(RUNTIME_JS).toContain('credentials: "same-origin"');
    expect(RUNTIME_JS).not.toContain('credentials: "include"');
    expect(RUNTIME_JS).toContain('attachShadow({ mode: "open" })');
    expect(RUNTIME_JS).toContain('"aria-live": "polite"');
  });
});

describe("the gap report", () => {
  const ev = (
    question: string,
    kind: FeedbackEvent["kind"] = "unanswered",
    day = "2026-11-01",
  ): FeedbackEvent => ({
    kind,
    question,
    note: null,
    lang: "de",
    day,
  });

  it("clusters questions about the same thing, ignoring helpful ratings", () => {
    const gaps = clusterGaps([
      ev("Liefert ihr in die Schweiz?"),
      ev("Versand in die Schweiz?", "unanswered", "2026-11-02"),
      ev("Was kostet der Versand in die Schweiz", "not_helpful"),
      ev("Versandkosten Schweiz?"),
      ev("Wo ist euer Büro?"),
      ev("Was kostet der Versand in die Schweiz?", "helpful"),
    ]);
    expect(gaps).toHaveLength(1);
    const g = gaps[0];
    expect(g?.words).toContain("schweiz");
    expect(g?.unanswered).toBeGreaterThanOrEqual(MIN_GAP_COUNT - 1);
    expect((g?.unanswered ?? 0) + (g?.notHelpful ?? 0)).toBeGreaterThanOrEqual(MIN_GAP_COUNT);
    expect(g?.suggestion).toBe("missing-page");
  });

  it("keeps languages apart and folds diacritics and stop words", () => {
    expect(questionWords("Wie lange dauert die Lieferung nach Österreich?")).toEqual([
      "lang",
      "dauert",
      "liefer",
      "osterreich",
    ]);
    const mixed = clusterGaps([
      ...[1, 2, 3].map(() => ev("Versand Schweiz")),
      ...[1, 2, 3].map(() => ({ ...ev("Versand Schweiz"), lang: "fr" })),
    ]);
    expect(mixed.map((g) => g.lang).sort()).toEqual(["de", "fr"]);
  });

  it("stays bounded and quick on many distinct questions", () => {
    const events = Array.from({ length: 20_000 }, (_, i) =>
      ev(`frage nummer${i} thema${i % 7000}`),
    );
    const started = performance.now();
    clusterGaps(events);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("test questions", () => {
  it("reads the list: a question, its page or none (off-topic), its language", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(
      testQuestionsOf([
        { values: { question: " Was kostet es? ", expect: { href: `caelo:page/${id}` } } },
        { values: { question: "Wie wird das Wetter?", lang: "de" } },
        { values: { question: "" } },
      ]),
    ).toEqual([
      { question: "Was kostet es?", expect: id, lang: null },
      { question: "Wie wird das Wetter?", expect: null, lang: "de" },
    ]);
    expect(linkedPageId(`caelo:page/${id}#x`)).toBe(id);
    expect(linkedPageId("/preise/")).toBeNull();
  });
});
