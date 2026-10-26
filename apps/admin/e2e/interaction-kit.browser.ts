// SPDX-License-Identifier: MPL-2.0

/**
 * issue #160 — the vetted interaction kit, exercised in a real browser.
 *
 * The page under test is the composer's own output (the same
 * `composePageWithLayout` the preview and the static build call), loaded
 * with `page.setContent`: the kit is pure markup + inline CSS/JS, so no
 * admin route is needed to prove it works. Pins, at phone width:
 *   - the built-in nav renders a working hamburger: hidden list, toggle
 *     with `aria-expanded`, Escape closes and returns focus;
 *   - accordion `data-single` keeps one panel open and a hash opens one;
 *   - tabs switch by click and by arrow keys with roving tabindex;
 *   - carousel buttons scroll the track;
 *   - the kit adds no serious/critical axe violation (WCAG 2.1 AA);
 *   - every snippet ships once, however many modules ask for it.
 */

import AxeBuilder from "@axe-core/playwright";
import {
  composePageWithLayout,
  createListRenderContext,
  DEFAULT_LIST_TYPES,
  INTERACTIONS,
} from "@caelo-cms/shared";
import { expect, type Page, test } from "@playwright/test";

const layoutHtml =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Kit</title></head><body><header><caelo-slot name="header"></caelo-slot></header><caelo-slot name="content"></caelo-slot></body></html>';
const templateHtml = '<main><caelo-slot name="content"></caelo-slot></main>';

function mod(n: number, slug: string, html: string, css = "") {
  return {
    moduleId: `44444444-4444-4444-8444-44444444440${n}`,
    slug,
    displayName: slug,
    html,
    css,
    js: "",
  };
}

const faq = mod(
  1,
  "faq",
  '<section class="faq"><h2>FAQ</h2><div data-caelo-ui="accordion" data-single>' +
    '<details id="q-1"><summary>First question</summary><p>First answer</p></details>' +
    '<details id="q-2"><summary>Second question</summary><p>Second answer</p></details>' +
    "</div></section>",
);
const plans = mod(
  2,
  "plans",
  '<section class="plans"><h2>Plans</h2><div data-caelo-ui="tabs">' +
    '<div role="tablist" aria-label="Billing period">' +
    '<button type="button" role="tab" id="t-month" aria-controls="p-month" aria-selected="true">Monthly</button>' +
    '<button type="button" role="tab" id="t-year" aria-controls="p-year" aria-selected="false" tabindex="-1">Yearly</button>' +
    "</div>" +
    '<div role="tabpanel" id="p-month" aria-labelledby="t-month"><p>10 per month</p></div>' +
    '<div role="tabpanel" id="p-year" aria-labelledby="t-year" hidden><p>100 per year</p></div>' +
    "</div></section>",
  // A module display rule must not unhide the inactive panel.
  ".plans [role=tabpanel]{display:block}",
);
const quotes = mod(
  3,
  "quotes",
  '<section class="quotes" data-caelo-ui="carousel" aria-roledescription="carousel" aria-label="Customer quotes">' +
    '<div data-caelo-carousel-track tabindex="0">' +
    '<div role="group" aria-roledescription="slide" aria-label="1 of 2"><p>Great</p></div>' +
    '<div role="group" aria-roledescription="slide" aria-label="2 of 2"><p>Superb</p></div>' +
    "</div>" +
    '<button type="button" data-caelo-carousel-prev aria-label="Previous slide"><span aria-hidden="true">&lsaquo;</span></button>' +
    '<button type="button" data-caelo-carousel-next aria-label="Next slide"><span aria-hidden="true">&rsaquo;</span></button>' +
    "</section>",
  ".quotes [data-caelo-carousel-track]{width:300px}",
);
// The module owns the menu markup and iterates a links list (epic #1107);
// the kit's `mobile-nav` only adds the behaviour.
const nav = {
  ...mod(
    4,
    "header-nav",
    '<nav class="caelo-nav-menu" data-caelo-ui="mobile-nav" data-nav-open="false">' +
      '<button type="button" class="caelo-nav-toggle" aria-expanded="false" aria-label="Menu">' +
      '<span class="caelo-nav-bar"></span><span class="caelo-nav-bar"></span><span class="caelo-nav-bar"></span></button>' +
      '<ul>{{#menu}}<li><a href="{{link}}">{{label}}</a></li>{{/menu}}</ul></nav>',
  ),
  fields: [
    {
      name: "menu",
      kind: "list" as const,
      listType: "links",
      default: [
        ["Home", "/"],
        ["Pricing", "/pricing"],
      ].map(([label, href], i) => ({
        id: `00000000-0000-4000-9000-00000000000${i + 1}`,
        node: "link",
        values: { label, link: { href } },
      })),
    },
  ],
};

/** Local lists of the shipped types need nothing but the types. */
const lists = createListRenderContext({
  listTypes: new Map(DEFAULT_LIST_TYPES.map((t) => [t.slug, { id: t.slug, def: t }])),
  lists: new Map(),
  pageTypes: new Map(),
  pages: new Map(),
  media: new Map(),
  siteLanguage: "en",
}).forPage(null);

/** The composed page; `repeat` places the tabs module a second time. */
function kitPage(repeat = false): string {
  return composePageWithLayout({
    templateHtml,
    templateCss: "",
    blocks: [
      {
        blockName: "content",
        modules: repeat ? [faq, plans, quotes, plans] : [faq, plans, quotes],
      },
    ],
    layoutHtml,
    layoutCss: "",
    layoutBlocks: [{ blockName: "header", modules: [nav] }],
    layoutSlug: "kit",
    lists,
  }).html;
}

async function load(page: Page): Promise<void> {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.setContent(kitPage());
}

test.describe("interaction kit (issue #160)", () => {
  test("ships every snippet exactly once", () => {
    // The tabs module placed twice: its snippet must still ship once.
    const html = kitPage(true);
    for (const id of ["mobile-nav", "accordion", "tabs", "carousel"] as const) {
      expect(html.split(INTERACTIONS[id].js).length - 1, id).toBe(1);
    }
  });

  test("mobile nav: hamburger toggles the list, Escape closes and refocuses", async ({ page }) => {
    await load(page);
    const toggle = page.locator(".caelo-nav-toggle");
    const list = page.locator(".caelo-nav-menu > ul");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(list).toBeHidden();

    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(list).toBeVisible();

    await page.getByRole("link", { name: "Pricing" }).focus();
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(list).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test("mobile nav: desktop width shows the list without a toggle", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setContent(kitPage());
    await expect(page.locator(".caelo-nav-toggle")).toBeHidden();
    await expect(page.locator(".caelo-nav-menu > ul")).toBeVisible();
  });

  test("accordion: data-single keeps one panel open", async ({ page }) => {
    await load(page);
    await page.getByText("First question").click();
    await expect(page.getByText("First answer")).toBeVisible();
    await page.getByText("Second question").click();
    await expect(page.getByText("Second answer")).toBeVisible();
    await expect(page.getByText("First answer")).toBeHidden();
  });

  test("accordion: a hash link opens its panel", async ({ page }) => {
    await load(page);
    await page.evaluate(() => {
      location.hash = "q-2";
    });
    await expect(page.getByText("Second answer")).toBeVisible();
  });

  test("tabs: click and arrow keys switch panels with a roving tabindex", async ({ page }) => {
    await load(page);
    const monthly = page.getByRole("tab", { name: "Monthly" });
    const yearly = page.getByRole("tab", { name: "Yearly" });
    await expect(page.getByText("100 per year")).toBeHidden();

    await yearly.click();
    await expect(yearly).toHaveAttribute("aria-selected", "true");
    await expect(monthly).toHaveAttribute("tabindex", "-1");
    await expect(page.getByText("100 per year")).toBeVisible();
    await expect(page.getByText("10 per month")).toBeHidden();

    await page.keyboard.press("ArrowLeft");
    await expect(monthly).toBeFocused();
    await expect(monthly).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("10 per month")).toBeVisible();
  });

  test("carousel: next and previous scroll the track", async ({ page }) => {
    await load(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const track = page.locator("[data-caelo-carousel-track]");
    await page.getByRole("button", { name: "Next slide" }).click();
    await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Previous slide" }).click();
    await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBe(0);
  });

  test("adds no serious or critical accessibility violation", async ({ page }) => {
    await load(page);
    // Open the menu and a panel so axe sees the expanded states too.
    await page.locator(".caelo-nav-toggle").click();
    await page.getByText("First question").click();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join("; ")}`),
    ).toEqual([]);
  });
});
