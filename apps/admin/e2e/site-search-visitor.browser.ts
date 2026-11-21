// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1651) — a visitor uses the site search in a real browser:
 * the empty field offers the start questions, typing suggests pages, a
 * search shows highlighted results, and a result opens its page at the
 * section that matched. The site is `apps/api-gateway/e2e/search-site.ts`:
 * the real gateway on its own database identity, answering from a
 * collection release, with the plugin's runtime on pages written the way
 * the plugin's skill teaches.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = resolve(REPO_ROOT, "apps/api-gateway/e2e/search-site.ts");

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
    const timer = setTimeout(() => fail(new Error("the search fixture did not start")), 60_000);
    lines.on("line", (line) => {
      const m = /^READY (\d+)/.exec(line);
      if (m) {
        clearTimeout(timer);
        ok(`http://127.0.0.1:${m[1]}`);
      }
    });
    proc.on("exit", (code) => fail(new Error(`the search fixture exited with ${code}`)));
  });
});

test.afterAll(async () => {
  proc?.kill("SIGTERM");
});

test("the empty field offers the start questions; typing suggests a page", async ({ page }) => {
  await page.goto(`${origin}/`);
  const input = page.getByRole("combobox", { name: "Suche" });
  await input.focus();
  await expect(page.getByRole("option", { name: "Was kostet es?" })).toBeVisible();
  await input.fill("Pre");
  const option = page.getByRole("option", { name: "Preise" });
  await expect(option).toBeVisible();
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", /-0$/);
  await option.click();
  await expect(page).toHaveURL(`${origin}/preise/`);
});

test("a search shows highlighted results and opens the matching section", async ({ page }) => {
  await page.goto(`${origin}/suche/?q=Rabatte`);
  const result = page.locator("[data-caelo-search-list] li").first();
  await expect(result).toContainText("Preise");
  await expect(result.locator("mark").first()).toHaveText(/Rabatte/i);
  await expect(page.locator("[data-caelo-search-summary]")).toHaveAttribute("data-total", "1");
  await result.locator("a").click();
  await expect(page).toHaveURL(`${origin}/preise/#rabatte`);
});

test("a typo is corrected", async ({ page }) => {
  await page.goto(`${origin}/suche/?q=Kontkt`);
  await expect(page.locator("[data-caelo-search-list] li").first()).toContainText("Kontakt");
  await expect(page.locator("[data-caelo-search-summary]")).toHaveAttribute(
    "data-correction",
    "kontakt",
  );
});
