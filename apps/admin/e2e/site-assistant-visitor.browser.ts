// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1655) — a visitor uses the site assistant in a real browser:
 * the site's own launcher opens the assistant (a Web Component in Shadow
 * DOM) with the AI disclosure and the privacy link; a question streams an
 * answer into the live region with a link to the page it comes from; a
 * rating with a note reaches the feedback inbox; the conversation stays in
 * the tab across pages; Escape closes it and gives the focus back. The site
 * is `apps/api-gateway/e2e/assistant-site.ts`: the real gateway on its own
 * database identity, site-search's index, and the visitor AI's scripted
 * model behind the provider seam (no real key).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = resolve(REPO_ROOT, "apps/api-gateway/e2e/assistant-site.ts");

test.describe.configure({ mode: "serial" });

let proc: ChildProcess;
let origin = "";

test.beforeAll(async () => {
  proc = spawn("bun", ["run", FIXTURE], {
    cwd: REPO_ROOT,
    env: { ...process.env, CAELO_TRUSTED_PROXY_HOPS: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  origin = await new Promise<string>((ok, fail) => {
    const lines = createInterface({ input: proc.stdout as NodeJS.ReadableStream });
    const timer = setTimeout(() => fail(new Error("the assistant fixture did not start")), 90_000);
    lines.on("line", (line) => {
      const m = /^READY (\d+)/.exec(line);
      if (m) {
        clearTimeout(timer);
        ok(`http://127.0.0.1:${m[1]}`);
      }
    });
    proc.on("exit", (code) => fail(new Error(`the assistant fixture exited with ${code}`)));
  });
});

test.afterAll(async () => {
  proc?.kill("SIGTERM");
});

test("asks, sees the answer stream with its source, rates it, and keeps the conversation", async ({
  page,
}) => {
  await page.goto(`${origin}/`);
  const launcher = page.getByRole("button", { name: "Fragen?" });
  await launcher.click();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  const dialog = page.getByRole("dialog", { name: "Fragen zur Website" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Antworten schreibt eine KI");
  await expect(dialog.getByRole("link", { name: "Datenschutz" })).toHaveAttribute(
    "href",
    "/datenschutz/",
  );
  const field = dialog.getByRole("textbox", { name: "Ihre Frage" });
  await expect(field).toBeFocused();

  await field.fill("Was kostet das Starter-Paket?");
  await field.press("Enter");
  const log = dialog.getByRole("log");
  await expect(log).toContainText("49 Euro");
  const source = log.getByRole("link", { name: "Preise" });
  await expect(source).toHaveAttribute("href", "/preise/#pakete");
  await expect(log).toHaveAttribute("aria-busy", "false");

  await dialog.getByRole("button", { name: "Nicht hilfreich" }).click();
  const note = dialog.getByRole("textbox", { name: "Was hat gefehlt? (optional)" });
  await note.fill("Die Versandkosten fehlen");
  await note.press("Enter");
  await expect(dialog).toContainText("Danke für Ihre Rückmeldung!");
  await expect
    .poll(
      async () => (await (await page.request.get(`${origin}/__test/feedback`)).json()) as unknown[],
    )
    .toEqual([
      {
        kind: "not_helpful",
        question: "Was kostet das Starter-Paket?",
        note: "Die Versandkosten fehlen",
      },
    ]);

  // The source opens its section; the conversation stays in this tab.
  await source.click();
  await expect(page).toHaveURL(`${origin}/preise/#pakete`);
  await page.getByRole("button", { name: "Fragen?" }).click();
  const again = page.getByRole("dialog", { name: "Fragen zur Website" });
  await expect(again.getByRole("log")).toContainText("Was kostet das Starter-Paket?");
  await expect(again.getByRole("log")).toContainText("49 Euro");

  await expect(again.getByRole("textbox", { name: "Ihre Frage" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(again).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fragen?" })).toBeFocused();
});

test("behind a gate that admits only the operator's cookie, the conversation still answers", async ({
  page,
  context,
}) => {
  // The staging gate: every request without the operator's cookie is refused.
  await context.addCookies([{ name: "__session", value: "staging-operator", url: origin }]);
  const refused: string[] = [];
  await page.route("**/api/**", async (route) => {
    if (!(route.request().headers().cookie ?? "").includes("__session=")) {
      refused.push(route.request().url());
      return route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
    }
    return route.continue();
  });
  await page.goto(`${origin}/`);
  await page.getByRole("button", { name: "Fragen?" }).click();
  const dialog = page.getByRole("dialog", { name: "Fragen zur Website" });
  const field = dialog.getByRole("textbox", { name: "Ihre Frage" });
  await field.fill("Was kostet das Starter-Paket?");
  await field.press("Enter");
  await expect(dialog.getByRole("log")).toContainText("49 Euro");
  expect(refused).toEqual([]);
});

// #1701 — the answer card on the search results page: the visitor's search
// query is answered in the page, in the site's own markup, with the pages
// it used; no launcher, no panel.
test("the results page answers the search query in the site's card, once, with its sources", async ({
  page,
}) => {
  const calls = async () =>
    (await (await page.request.get(`${origin}/__test/model-calls`)).json()) as number;
  const before = await calls();
  await page.goto(`${origin}/suche/#q=Starter-Paket kosten`);
  const card = page.locator("[data-caelo-assistant-answer]");
  await expect(card).toBeVisible();
  // The site's own disclosure stays in the card.
  await expect(card).toContainText("Antworten schreibt eine KI");
  const turn = card.locator("[data-caelo-assistant-thread] article").first();
  await expect(turn.locator('[data-field="question"]')).toHaveText("Starter-Paket kosten");
  await expect(turn.locator('[data-field="answer"]')).toContainText("49 Euro");
  await expect(card).toHaveAttribute("data-caelo-assistant-state", "done");
  // The cited page, from the site's source template.
  const source = turn.locator('[data-field="sources"] a').first();
  await expect(source).toHaveText("Preise");
  await expect(source).toHaveAttribute("href", "/preise/#pakete");
  // No Web Component, no floating panel: the card is the page's own markup.
  await expect(page.locator("caelo-assistant")).toHaveCount(0);
  // The search results beside it read the same query.
  await expect(page.locator("[data-caelo-search-list] li").first()).toContainText("Preise");
  const asked = (await calls()) - before;
  expect(asked).toBeGreaterThan(0);

  // A reload shows the answer again from this tab: nothing is asked twice.
  await page.reload();
  await expect(card.locator('[data-field="answer"]').first()).toContainText("49 Euro");
  expect((await calls()) - before).toBe(asked);

  // The follow-up continues the conversation in the card.
  const follow = card.getByRole("textbox", { name: "Ihre Frage" });
  await expect(follow).toBeVisible();
  await follow.fill("Liefern Sie in die Schweiz?");
  await follow.press("Enter");
  const second = card.locator("[data-caelo-assistant-thread] article").nth(1);
  await expect(second.locator('[data-field="answer"]')).toContainText("Schweiz");
  await expect(card).toHaveAttribute("data-caelo-assistant-state", "done");

  // A rating reaches the feedback inbox.
  await second.getByRole("button", { name: "Hilfreich", exact: true }).click();
  await expect(second).toContainText("Danke für Ihre Rückmeldung!");
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`${origin}/__test/feedback`)).json()) as { kind: string }[],
    )
    .toContainEqual(expect.objectContaining({ kind: "helpful" }));

  // A new search in hash mode: a new answer for the new query, no reload.
  const search = page.getByRole("combobox", { name: "Suche" });
  await search.fill("Kontakt");
  await search.press("Enter");
  await expect(page).toHaveURL(`${origin}/suche/#q=Kontakt`);
  await expect(card.locator("[data-caelo-assistant-thread] article")).toHaveCount(1);
  await expect(card.locator('[data-field="question"]')).toHaveText("Kontakt");
  await expect(card.locator('[data-field="answer"]')).toContainText("selben Tag");

  // Back to the first search: its conversation comes back, follow-up
  // included, and nothing is asked again (review on #1742).
  await expect(card).toHaveAttribute("data-caelo-assistant-state", "done");
  const beforeBack = await calls();
  await page.goBack();
  await expect(card.locator("[data-caelo-assistant-thread] article")).toHaveCount(2);
  await expect(card.locator('[data-field="answer"]').nth(1)).toContainText("Schweiz");
  expect(await calls()).toBe(beforeBack);

  // The query never reached the server in a page request.
  const seen = (await (await page.request.get(`${origin}/__test/requests`)).json()) as string[];
  expect(seen.filter((r) => r.startsWith("/suche/"))).toEqual(["/suche/", "/suche/"]);
});

test("without the AI disclosure the card asks nothing and stays hidden", async ({ page }) => {
  const calls = async () =>
    (await (await page.request.get(`${origin}/__test/model-calls`)).json()) as number;
  const before = await calls();
  await page.goto(`${origin}/suche-ohne-hinweis/#q=Starter-Paket`);
  const card = page.locator("[data-caelo-assistant-answer]");
  await expect(card).toHaveAttribute("data-caelo-assistant-state", "disclosure-missing");
  await expect(card).toBeHidden();
  // The results still answer.
  await expect(page.locator("[data-caelo-search-list] li").first()).toContainText("Preise");
  expect(await calls()).toBe(before);
});

// #1701 — the ask card: the assistant embedded in any page, with its own
// question field, no search query, no launcher and no floating panel.
test("an ask card on a page without a query answers a typed question with its source and a follow-up", async ({
  page,
}) => {
  const calls = async () =>
    (await (await page.request.get(`${origin}/__test/model-calls`)).json()) as number;
  await page.goto(`${origin}/produkt/`);
  const card = page.locator('[data-caelo-assistant-answer="ask"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("Antworten schreibt eine KI");
  await expect(page.locator("caelo-assistant")).toHaveCount(0);
  const field = card.getByRole("textbox", { name: "Ihre Frage" });
  await expect(field).toBeVisible();
  await field.fill("Was kostet das Starter-Paket?");
  await field.press("Enter");
  const first = card.locator("[data-caelo-assistant-thread] article").first();
  await expect(first.locator('[data-field="question"]')).toHaveText(
    "Was kostet das Starter-Paket?",
  );
  await expect(first.locator('[data-field="answer"]')).toContainText("49 Euro");
  await expect(first.locator('[data-field="sources"] a').first()).toHaveAttribute(
    "href",
    "/preise/#pakete",
  );
  await expect(card).toHaveAttribute("data-caelo-assistant-state", "done");

  await field.fill("Liefern Sie in die Schweiz?");
  await field.press("Enter");
  const second = card.locator("[data-caelo-assistant-thread] article").nth(1);
  await expect(second.locator('[data-field="answer"]')).toContainText("Schweiz");
  await expect(card).toHaveAttribute("data-caelo-assistant-state", "done");

  // A reload shows this card's conversation again, asking nothing.
  const asked = await calls();
  await page.reload();
  await expect(card.locator("[data-caelo-assistant-thread] article")).toHaveCount(2);
  await expect(card.locator('[data-field="answer"]').nth(1)).toContainText("Schweiz");
  expect(await calls()).toBe(asked);
});

test("an ask card without the AI disclosure asks nothing and stays hidden", async ({ page }) => {
  const calls = async () =>
    (await (await page.request.get(`${origin}/__test/model-calls`)).json()) as number;
  const before = await calls();
  await page.goto(`${origin}/produkt-ohne-hinweis/`);
  const card = page.locator("[data-caelo-assistant-answer]");
  await expect(card).toHaveAttribute("data-caelo-assistant-state", "disclosure-missing");
  await expect(card).toBeHidden();
  expect(await calls()).toBe(before);
});

test("two ask cards on one page keep their own conversations", async ({ page }) => {
  await page.goto(`${origin}/zwei-karten/`);
  const cards = page.locator('[data-caelo-assistant-answer="ask"]');
  await expect(cards).toHaveCount(2);
  const [one, two] = [cards.nth(0), cards.nth(1)];
  await expect(one).toBeVisible();
  await expect(two).toBeVisible();

  const ask = async (card: typeof one, question: string) => {
    const field = card.getByRole("textbox", { name: "Ihre Frage" });
    await field.fill(question);
    await field.press("Enter");
    await expect(card).toHaveAttribute("data-caelo-assistant-state", "done");
  };
  await ask(one, "Was kostet das Starter-Paket?");
  await expect(one.locator('[data-field="answer"]')).toContainText("49 Euro");
  // The other card shows nothing of it.
  await expect(two.locator("[data-caelo-assistant-thread] article")).toHaveCount(0);

  await ask(two, "Kontakt");
  await expect(two.locator('[data-field="answer"]')).toContainText("selben Tag");
  await expect(one.locator("[data-caelo-assistant-thread] article")).toHaveCount(1);

  // Each card gets its own conversation back after a reload, and the
  // product page's card (another page) is not either of them.
  await page.reload();
  await expect(one.locator('[data-field="question"]')).toHaveText([
    "Was kostet das Starter-Paket?",
  ]);
  await expect(two.locator('[data-field="question"]')).toHaveText(["Kontakt"]);
});
