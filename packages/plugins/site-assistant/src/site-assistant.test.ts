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
  linkedPageId,
  SITE_TEXT_KEYS,
  testQuestionsOf,
  WIDGET_MARKUP,
} from "./index.js";
import { RUNTIME_JS } from "./runtime.js";
import {
  answered,
  answerParts,
  appendTurn,
  checkQuestion,
  conversationFull,
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
    for (const key of Object.keys(SITE_TEXT_KEYS))
      expect(`${WIDGET_MARKUP}\n${ANSWER_MARKUP}`).toContain(`{{site_text.${key}}}`);
    // Every key either markup names is a documented site text.
    for (const m of `${WIDGET_MARKUP}\n${ANSWER_MARKUP}`.matchAll(/\{\{site_text\.([a-z_]+)\}\}/g))
      expect(Object.keys(SITE_TEXT_KEYS)).toContain(m[1] as string);
    expect(WIDGET_MARKUP).toContain('data-caelo-plugin="site-assistant"');
  });

  it("#1701 — the answer card is the site's own markup, hidden until it answers, with the disclosure", () => {
    expect(ANSWER_MARKUP).toMatch(/^<section data-caelo-assistant-answer hidden /);
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
      "data-caelo-assistant-followup hidden",
      "data-caelo-assistant-input",
      'data-text="handoff"',
      'data-caelo-plugin="site-assistant"',
    ])
      expect(ANSWER_MARKUP).toContain(contract);
    // No floating panel, no Web Component: it is not the widget.
    expect(ANSWER_MARKUP).not.toContain("data-caelo-assistant-open");
    expect(ANSWER_MARKUP).not.toContain("<script");
  });

  it("#1701 — get_site_assistant_setup hands out both markups", async () => {
    const setup = (await (
      plugin.operations.setup as (c: unknown, a: unknown) => Promise<Record<string, unknown>>
    )({ config: { get: async () => ({}) } }, {})) as { widgetMarkup: string; answerMarkup: string };
    expect(setup.widgetMarkup).toBe(WIDGET_MARKUP);
    expect(setup.answerMarkup).toBe(ANSWER_MARKUP);
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
