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
