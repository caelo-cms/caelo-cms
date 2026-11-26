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

// #1707 — the operator keeps search terms out of addresses: the form in hash
// mode opens `#q=…`, which no request carries, and the results page follows
// the fragment without a reload.
test("a hash-mode search keeps the query out of every page request and follows #q= without a reload", async ({
  page,
}) => {
  await page.goto(`${origin}/start-hash/`);
  const input = page.getByRole("combobox", { name: "Suche" });
  await input.fill("Rabatte");
  await input.press("Enter");
  await expect(page).toHaveURL(`${origin}/suche-hash/#q=Rabatte`);
  const results = page.locator("[data-caelo-search-results]");
  await expect(results.locator("[data-caelo-search-list] li").first()).toContainText("Preise");
  await expect(results).toHaveAttribute("data-caelo-search-state", "done");
  await expect(results).not.toHaveAttribute("aria-busy", "true");
  // The field shows the query it searched.
  await expect(input).toHaveValue("Rabatte");

  // A new search on the results page: only the fragment changes. The page
  // stays the same document, announces the start, and shows the new hits.
  await page.evaluate(() => {
    const w = window as unknown as { __sameDocument: boolean; __started: string[] };
    w.__sameDocument = true;
    w.__started = [];
    document.addEventListener("caelo-search-start", (e) => {
      w.__started.push((e as CustomEvent<{ query: string }>).detail.query);
    });
  });
  await input.fill("Kontkt");
  await input.press("Enter");
  await expect(page).toHaveURL(`${origin}/suche-hash/#q=Kontkt`);
  await expect(results.locator("[data-caelo-search-list] li").first()).toContainText("Kontakt");
  expect(
    await page.evaluate(() => {
      const w = window as unknown as { __sameDocument?: boolean; __started?: string[] };
      return { same: w.__sameDocument === true, started: w.__started };
    }),
  ).toEqual({ same: true, started: ["Kontkt"] });

  // Back to the first query: the fragment changes again, the results follow.
  // The field still has the focus; Back must still show the query searched.
  await expect(input).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(`${origin}/suche-hash/#q=Rabatte`);
  await expect(results.locator("[data-caelo-search-list] li").first()).toContainText("Preise");
  await expect(input).toHaveValue("Rabatte");
  // A skip link is no search: the results stay.
  await page.getByRole("link", { name: "Zum Inhalt" }).click();
  await expect(page).toHaveURL(`${origin}/suche-hash/#main`);
  await expect(results.locator("[data-caelo-search-list] li").first()).toContainText("Preise");

  // The server saw the pages, never a query (the ?q= tests above use /suche/).
  const seen = (await (await page.request.get(`${origin}/__test/requests`)).json()) as string[];
  const hashPages = seen.filter(
    (r) => r.startsWith("/suche-hash/") || r.startsWith("/start-hash/"),
  );
  expect(hashPages).toContain("/suche-hash/");
  expect(hashPages.filter((r) => r.includes("?"))).toEqual([]);
});

test("behind a gate that admits only the operator's cookie, the search sends the page's own", async ({
  page,
  context,
}) => {
  // The staging gate: a read without the operator's cookie is refused.
  await context.addCookies([{ name: "__session", value: "staging-operator", url: origin }]);
  const refused: string[] = [];
  await page.route("**/api/plugin/site-search/**", async (route) => {
    if (!(route.request().headers().cookie ?? "").includes("__session=")) {
      refused.push(route.request().url());
      return route.fulfill({ status: 403, contentType: "application/json", body: "{}" });
    }
    return route.continue();
  });
  await page.goto(`${origin}/suche/?q=Rabatte`);
  await expect(page.locator("[data-caelo-search-list] li").first()).toContainText("Preise");
  // A cookie-less try (two when the warm-up ran beside it), then the page's
  // credentials for the rest.
  expect(refused.length).toBeGreaterThanOrEqual(1);
  expect(refused.length).toBeLessThanOrEqual(2);
});
