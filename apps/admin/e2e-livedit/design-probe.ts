// SPDX-License-Identifier: MPL-2.0

/**
 * issue #161 tier 2 — the Playwright half of the design-quality suite.
 *
 * Collects COMPUTED styles from a published page (what visitors actually
 * see, after theme vars, base CSS, module CSS and web-font loading have
 * all resolved) and hands them to the pure checks in
 * `./lib/design-assertions.ts`. The theme-token analysis on main proves
 * the palette EXISTS; these probes prove the page USES it.
 *
 * Also owns the run artifact `design-report.jsonl`: one line per probe
 * with the measured values, the deterministic violations and the
 * non-blocking AI-judge scores, so the trend survives green runs (the
 * workflow uploads it on every run as `e2e-livedit-design-<run_id>`).
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { ADMIN_LOG_DIR } from "./global-setup.js";
import type {
  ColorSample,
  CtaCandidate,
  FontSample,
  StyleSnapshot,
  TypeSample,
} from "./lib/design-assertions.js";
import { type DesignRubricScores, fetchDesignRubricScores } from "./lib/vision-verdict.js";

/** Everything one design probe measures on the current page. */
export interface DesignProbe {
  readonly colors: ColorSample;
  readonly type: TypeSample;
  readonly fonts: FontSample;
}

/**
 * Measure the page in the browser. Waits for `document.fonts.ready` first
 * so a web font that is still loading is not reported as missing.
 * "Visible" = rendered with a non-zero box and not `visibility: hidden`.
 */
export async function probeDesign(page: Page): Promise<DesignProbe> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const isVisible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      // Opacity is deliberately NOT checked: reveal-on-scroll modules park
      // below-the-fold sections at opacity 0 until scrolled into view, and
      // they are still part of the page's design.
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none";
    };
    const ownText = (el: Element): boolean =>
      [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);

    const all = [...document.body.querySelectorAll("*")].slice(0, 4000).filter(isVisible);
    const usedColors: string[] = [];
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (ownText(el)) usedColors.push(cs.color);
      usedColors.push(cs.backgroundColor);
      // Gradient stops are palette use too (a primary→accent hero band).
      for (const m of cs.backgroundImage.matchAll(
        /(?:rgba?|oklch|oklab|lab|lch|color)\([^()]*\)/g,
      )) {
        usedColors.push(m[0]);
      }
      if (Number.parseFloat(cs.borderTopWidth) > 0) usedColors.push(cs.borderTopColor);
    }

    // Wide blocks are where section rhythm shows: a full-bleed hero, a
    // tinted band, a dark footer. Nesting depth varies per module, so any
    // wide, tall-enough element counts — not just top-level tags.
    const wide = all.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= window.innerWidth * 0.9 && r.height >= 80;
    });
    const sections = wide.slice(0, 60).map((el) => {
      const cs = getComputedStyle(el);
      const cls = typeof el.className === "string" ? el.className.split(/\s+/)[0] : "";
      return {
        label: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`,
        backgroundColor: cs.backgroundColor,
        backgroundImage: cs.backgroundImage,
      };
    });
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    const transparent = (c: string) => c === "transparent" || c === "rgba(0, 0, 0, 0)";
    // A fully transparent root paints the browser canvas, which is white.
    const pageBackground = !transparent(bodyBg)
      ? bodyBg
      : !transparent(htmlBg)
        ? htmlBg
        : "rgb(255, 255, 255)";

    const px = (sel: string, minText = 0): number[] =>
      [...document.querySelectorAll(sel)]
        .filter((el) => isVisible(el) && (el.textContent ?? "").trim().length >= minText)
        .map((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    const firstVisible = (sel: string, minText = 0): Element | null =>
      [...document.querySelectorAll(sel)].find(
        (el) => isVisible(el) && (el.textContent ?? "").trim().length >= minText,
      ) ?? null;
    const h1 = firstVisible("h1");
    const p = firstVisible("p", 20);

    return {
      colors: { pageBackground, usedColors, sections },
      type: { h1Px: px("h1"), h2Px: px("h2"), paragraphPx: px("p", 20) },
      fonts: {
        loadedFamilies: [...document.fonts]
          .filter((f) => f.status === "loaded")
          .map((f) => f.family),
        h1FontFamily: h1 ? getComputedStyle(h1).fontFamily : "",
        bodyFontFamily: p
          ? getComputedStyle(p).fontFamily
          : getComputedStyle(document.body).fontFamily,
      },
    };
  });
}

/** The two roles the cross-page consistency check compares. */
export interface RoleStyles {
  /** Main-content links/buttons in document order (nav/header/footer excluded). */
  readonly ctaCandidates: readonly CtaCandidate[];
  /** First visible main-content h2, or null when the page has none. */
  readonly h2: StyleSnapshot | null;
}

/**
 * Collect the computed styles of the page's CTA candidates and its first
 * section heading. Chrome (nav, header, footer) is excluded: it is shared
 * layout and identical across pages by construction, so comparing it
 * would prove nothing about the page bodies.
 */
export async function probeRoleStyles(page: Page): Promise<RoleStyles> {
  return page.evaluate(() => {
    const inChrome = (el: Element) => el.closest("nav, header, footer") !== null;
    const isVisible = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const pick = (el: Element, props: readonly string[]): Record<string, string> => {
      const cs = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
    };
    const ctaCandidates = [...document.querySelectorAll("a, button")]
      .filter((el) => isVisible(el) && !inChrome(el))
      .slice(0, 40)
      .map((el) => ({
        text: (el.textContent ?? "").trim().slice(0, 60),
        styles: pick(el, [
          "background-color",
          "color",
          "border-radius",
          "font-family",
          "font-weight",
        ]),
      }));
    const h2El = [...document.querySelectorAll("h2")].find((el) => isVisible(el) && !inChrome(el));
    return {
      ctaCandidates,
      h2: h2El ? pick(h2El, ["font-family", "font-weight", "font-size"]) : null,
    };
  });
}

/** Result of the non-blocking judge: scores, or the error that prevented them. */
export type DesignJudgeResult =
  | { readonly ok: true; readonly scores: DesignRubricScores }
  | { readonly ok: false; readonly error: string };

/**
 * Screenshot the current page and ask the vision judge for design scores.
 *
 * NON-BLOCKING by design (issue #161: promote only after the determinism
 * recipe has measured the variance), so a judge failure is returned as a
 * value and recorded in the artifact — loudly, with its message — rather
 * than failing a scenario whose deterministic assertions all passed.
 */
export async function judgeDesign(page: Page): Promise<DesignJudgeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY_E2E;
  if (!apiKey) {
    return { ok: false, error: "ANTHROPIC_API_KEY_E2E is unset" };
  }
  try {
    const buffer = await page.screenshot({ fullPage: true, type: "png" });
    const scores = await fetchDesignRubricScores({
      apiKey,
      screenshotBase64: buffer.toString("base64"),
      mediaType: "image/png",
    });
    return { ok: true, scores };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** One line per probe; global-setup truncates it at the start of a run. */
export const DESIGN_REPORT_JSONL = resolve(ADMIN_LOG_DIR, "design-report.jsonl");

/**
 * Append one design-report line (scenario, page, measurements, violations,
 * judge result) and echo a one-line summary into the test log.
 */
export function recordDesignReport(entry: {
  readonly scenario: string;
  readonly url: string;
  readonly probe?: DesignProbe;
  readonly violations: readonly string[];
  readonly judge?: DesignJudgeResult;
}): void {
  appendFileSync(
    DESIGN_REPORT_JSONL,
    `${JSON.stringify({ ...entry, recordedAt: new Date().toISOString() })}\n`,
  );
  const judge = entry.judge
    ? entry.judge.ok
      ? `hierarchy=${entry.judge.scores.hierarchy} contrast=${entry.judge.scores.contrast} rhythm=${entry.judge.scores.rhythm} polish=${entry.judge.scores.polish}`
      : `judge-error=${entry.judge.error.slice(0, 160)}`
    : "judge=skipped";
  // eslint-disable-next-line no-console -- surfaced in the e2e log on purpose.
  console.log(
    `[design-report] ${entry.scenario} ${entry.url}: ${entry.violations.length} violation(s); ${judge}`,
  );
}
