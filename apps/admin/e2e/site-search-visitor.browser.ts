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

// The suggestions open only on the visitor's own input. A search that goes
// out drops the suggestion the last keystroke still had pending and an
// answer on its way, and so does the results page putting its query into
// the field on Back: the pending one would ask for that query and open the
// list over the results (it covered the skip link in the test above). The
// page's clock is paused, so the debounce runs only when the test lets the
// time run; each suggestion is recorded as the page sends it.
test("a search and Back drop the suggestion still to come; only typing opens the list", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Every suggestion asked, as it goes out, and each answer once the page
    // handled it: a task after its body was read (rendering takes microtasks).
    const w = window as unknown as { __suggested: string[]; __answered: string[] };
    w.__suggested = [];
    w.__answered = [];
    window.fetch = new Proxy(window.fetch, {
      apply(target, self, args: Parameters<typeof fetch>) {
        const pending: Promise<Response> = Reflect.apply(target, self, args);
        const input = args[0];
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (!url.pathname.endsWith("/site-search/suggest")) return pending;
        const q = url.searchParams.get("q") ?? "";
        w.__suggested.push(q);
        return pending.then((res) => {
          const read = res.json.bind(res);
          res.json = () =>
            read().then((body: unknown) => {
              const handled = new MessageChannel();
              handled.port1.onmessage = () => w.__answered.push(q);
              handled.port2.postMessage(null);
              return body;
            });
          return res;
        });
      },
    });
  });
  const seen = () =>
    page.evaluate(() => {
      const w = window as unknown as { __suggested: string[]; __answered: string[] };
      return { suggested: [...w.__suggested], answered: [...w.__answered] };
    });
  // The first suggestion's answer waits until the test lets it through.
  let letThrough: () => void = () => {};
  const held = new Promise<void>((done) => {
    letThrough = done;
  });
  let holding = true;
  await page.route(/\/api\/plugin\/site-search\/suggest\?/, async (route) => {
    if (holding) {
      holding = false;
      await held;
    }
    await route.continue();
  });
  const start = new Date("2026-01-05T09:00:00Z").getTime();
  await page.clock.install({ time: start });
  await page.goto(`${origin}/suche-hash/#q=Rabatte`);
  await page.clock.pauseAt(start + 60_000);
  const input = page.getByRole("combobox", { name: "Suche" });
  const suggestions = page.locator("[data-caelo-search-suggestions]");
  const first = page.locator("[data-caelo-search-results] [data-caelo-search-list] li").first();
  await expect(first).toContainText("Preise");

  // Focus asks for the field's query; the visitor types a new one and
  // searches before that answer or the debounce came.
  await input.focus();
  await expect.poll(async () => (await seen()).suggested).toEqual(["Rabatte"]);
  await input.fill("Kontkt");
  await input.press("Enter");
  await expect(first).toContainText("Kontakt");
  letThrough();
  await expect.poll(async () => (await seen()).answered).toEqual(["Rabatte"]);
  await expect(suggestions).toBeHidden();

  // Back puts the first query into the field. The time runs past the
  // debounce: nothing is asked for, nothing opens.
  await page.goBack();
  await expect(first).toContainText("Preise");
  await expect(input).toHaveValue("Rabatte");
  await page.clock.runFor(1000);
  expect((await seen()).suggested).toEqual(["Rabatte"]);
  await expect(suggestions).toBeHidden();
  await expect(input).toHaveAttribute("aria-expanded", "false");

  // Typing without searching, then Forward and Back: the page's query
  // replaces the typed one, and the typed one's suggestion is dropped.
  await page.goForward();
  await expect(first).toContainText("Kontakt");
  await input.fill("Pre");
  await page.goBack();
  await expect(first).toContainText("Preise");
  await expect(input).toHaveValue("Rabatte");
  await page.clock.runFor(1000);
  expect((await seen()).suggested).toEqual(["Rabatte"]);
  await expect(suggestions).toBeHidden();

  // The visitor's own typing still opens the list once the debounce ran.
  await input.fill("Pre");
  await page.clock.runFor(1000);
  expect((await seen()).suggested).toEqual(["Rabatte", "Pre"]);
  await expect(page.getByRole("option", { name: "Preise" })).toBeVisible();
  await expect(input).toHaveAttribute("aria-expanded", "true");
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

// #1745 — a first search on searchVIU lost its gateway instance, and
// the page showed "Suche nicht erreichbar" at once. A search that fails
// without an answer or with a 5xx is now sent once more first.
test("a search whose first answer is a 503 shows the results of the repeat", async ({ page }) => {
  let searches = 0;
  await page.route(/\/api\/plugin\/site-search\/search\?/, async (route) => {
    searches++;
    if (searches === 1) {
      return route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false}' });
    }
    return route.continue();
  });
  await page.goto(`${origin}/suche/?q=Rabatte`);
  const results = page.locator("[data-caelo-search-results]");
  await expect(results.locator("[data-caelo-search-list] li").first()).toContainText("Preise");
  await expect(results).toHaveAttribute("data-caelo-search-state", "done");
  expect(searches).toBe(2);
});

test("a search that fails twice shows the error state, after exactly one repeat", async ({
  page,
}) => {
  let searches = 0;
  await page.route(/\/api\/plugin\/site-search\/search\?/, async (route) => {
    searches++;
    return route.abort("connectionreset");
  });
  await page.goto(`${origin}/suche/?q=Rabatte`);
  const results = page.locator("[data-caelo-search-results]");
  await expect(results).toHaveAttribute("data-caelo-search-state", "error");
  await expect(results).toHaveAttribute("data-caelo-search-error", "true");
  expect(searches).toBe(2);
});
