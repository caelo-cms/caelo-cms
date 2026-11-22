// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1655) — the site assistant on the real gateway, its real
 * database identity and site-search's real index, with the AI SDK's mock
 * model behind the provider seam (no key, no provider):
 *
 * - its conversation's prompt is the core's rules, then the released
 *   persona, scope and handoff text — nothing else of its configuration;
 * - the model is offered site-search's search and read, nothing more, and
 *   the answer's sources are site-search's pages;
 * - feedback is a declaration: kept only while the released setting is on,
 *   with the same answer when it is off, for a honeypot, and for personal
 *   data in the question or the note; without a proof it is refused.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import siteAssistant from "@caelo-cms/plugin-site-assistant";
import {
  ASSISTANT_SITE_PAGES,
  type AssistantSite,
  prepareAssistantSite,
} from "../e2e/assistant-test-site.js";
import { handleRequest } from "./server.js";
import { TEST_LIVE_ORIGIN } from "./test-support.js";
import { setVisitorAiModelFactoryForTests } from "./visitor-ai/provider.js";
import { scriptedVisitorModel } from "./visitor-ai/scripted-model.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL as string;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL as string;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL as string;
const STAGING_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL as string;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL || !STAGING_URL)
  throw new Error("DB URLs required");

const SLUG = "site-assistant";
let site: AssistantSite;
let ip = 0;

function headers(): Record<string, string> {
  ip++;
  return {
    "Content-Type": "application/json",
    Origin: TEST_LIVE_ORIGIN,
    "X-Forwarded-For": `203.0.113.${ip % 250}`,
  };
}

async function proof(scope: string): Promise<{ challenge: string; nonce: string }> {
  const r = await handleRequest(
    new Request(`http://localhost/api/captcha/challenge?for=${scope}`, { headers: headers() }),
  );
  expect(r.status).toBe(200);
  const { challenge, target } = (
    (await r.json()) as { data: { challenge: string; target: string } }
  ).data;
  for (let nonce = 0; ; nonce++)
    if (
      new Bun.CryptoHasher("sha256")
        .update(`${challenge}|${scope}|${nonce}`)
        .digest("hex")
        .startsWith(target)
    )
      return { challenge, nonce: String(nonce) };
}

async function ask(question: string) {
  const r = await handleRequest(
    new Request(`http://localhost/api/plugin/${SLUG}/ask`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        question,
        lang: "de",
        history: [],
        captcha: await proof(`${SLUG}.ask`),
      }),
    }),
  );
  const text = await r.text();
  const events = text
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((b) => ({
      event: /^event: (.+)$/m.exec(b)?.[1] ?? "",
      data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? "{}") as Record<string, unknown>,
    }));
  return { status: r.status, events };
}

async function feedback(body: Record<string, unknown>, withProof = true): Promise<Response> {
  const extra = withProof ? { _caelo_captcha: await proof(`${SLUG}.feedback`) } : {};
  return handleRequest(
    new Request(`http://localhost/api/plugin/${SLUG}/feedback`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ ...body, ...extra }),
    }),
  );
}

beforeAll(async () => {
  process.env.CAELO_TRUSTED_PROXY_HOPS = "1";
  site = await prepareAssistantSite({
    admin: ADMIN_URL,
    publicAdmin: PUBLIC_ADMIN_URL,
    publicGateway: PUBLIC_URL,
    stagingAdmin: STAGING_URL,
  });
}, 120_000);

afterAll(async () => {
  setVisitorAiModelFactoryForTests(null);
  await site?.restore();
});

describe("the site assistant's conversation (#1655)", () => {
  it("answers from site-search's pages with its released settings after the core's rules", async () => {
    const scripted = scriptedVisitorModel();
    setVisitorAiModelFactoryForTests(() => scripted.model);
    const r = await ask("Was kostet das Starter-Paket?");
    expect(r.status).toBe(200);
    expect(r.events.map((e) => e.event)).toContain("done");
    const sources = (r.events.find((e) => e.event === "sources")?.data.sources ?? []) as {
      url: string;
      cited: boolean;
    }[];
    expect(sources.some((s) => s.url === ASSISTANT_SITE_PAGES[0].path && s.cited)).toBe(true);

    const call = scripted.calls[0];
    // Only site-search's search and read: nothing to write with.
    expect([...(call?.tools ?? [])].sort()).toEqual(["site_search__read", "site_search__search"]);
    const prompt = call?.prompt ?? "";
    const defaults = siteAssistant.config as Record<
      string,
      { fields: Record<string, { default: unknown }> }
    >;
    const assistant = defaults.assistant?.fields ?? {};
    const rules = prompt.indexOf("only from the website's own pages");
    expect(rules).toBeGreaterThanOrEqual(0);
    for (const field of ["persona", "scope", "handoff"]) {
      const at = prompt.indexOf(String(assistant[field]?.default));
      expect(at).toBeGreaterThan(rules);
      expect(prompt).toContain(`name="assistant.${field}"`);
    }
    // The feedback switch is published for the inbox, never put into the prompt.
    expect(prompt).not.toContain("feedback.enabled");
  });
});

describe("the site assistant's feedback (#1655)", () => {
  const rating = { kind: "not_helpful", question: "Liefert ihr in die Schweiz?", lang: "de" };

  it("keeps nothing while feedback is off, and says so no differently", async () => {
    await site.setFeedback(false);
    const r = await feedback(rating);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ recorded: true });
    expect(await site.feedback()).toEqual([]);
  });

  it("keeps a rating with its question and note once feedback is released on", async () => {
    await site.setFeedback(true);
    const r = await feedback({ ...rating, note: "  Versandkosten fehlen  " });
    expect(r.status).toBe(200);
    expect(await site.feedback()).toEqual([
      {
        kind: "not_helpful",
        question: "Liefert ihr in die Schweiz?",
        note: "Versandkosten fehlen",
      },
    ]);
  });

  it("drops personal data in the question or the note, and a filled honeypot, with the same answer", async () => {
    const before = (await site.feedback()).length;
    for (const body of [
      { ...rating, question: "Mail an max@example.com?" },
      { ...rating, note: "ruft mich an: +49 170 1234567" },
      { ...rating, website: "http://spam.example" },
    ]) {
      const r = await feedback(body);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { data: unknown }).data).toEqual({ recorded: true });
    }
    expect((await site.feedback()).length).toBe(before);
  });

  it("refuses a call without proof and a field the declaration does not name", async () => {
    const before = (await site.feedback()).length;
    expect((await feedback(rating, false)).status).toBe(403);
    expect((await feedback({ ...rating, answer: "the whole answer" })).status).toBe(400);
    expect((await site.feedback()).length).toBe(before);
  });
});
