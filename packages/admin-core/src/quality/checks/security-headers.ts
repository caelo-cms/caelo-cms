// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1454 — the core `security-headers` check: what the staged build
 * says about the site's CSP (docs/dev/site-security-headers.md).
 *
 * The build derives the CSP from its own pages, so a resource in the markup
 * is never a violation. What it cannot derive is reported here: markup no
 * CSP without `'unsafe-inline'` lets run, and a policy that did not fit a
 * response header. Runtime loads are the Lighthouse run's part: the audited
 * origin sends the build's headers, so a report-only violation fails
 * `inspector-issues` and an enforced one `errors-in-console` too, each with
 * the next step (csp-violations.ts).
 *
 * Under `report_only` nothing is blocked for a visitor, so these are
 * warnings: they must not stop a Publish live on a site that works. Under
 * `enforce` the same markup stops working for every visitor, so they are
 * errors, which block it.
 *
 * Rules:
 *   - `security-headers/inline-handler`  an `onclick=` attribute
 *   - `security-headers/javascript-url`  a `javascript:` link
 *   - `security-headers/data-script`     a script from a `data:` URL
 *   - `security-headers/foreign-base`    a `<base>` on another origin
 *   - `security-headers/csp-too-large`   the CSP did not fit
 */

import { parseSiteHeaderSet, SECURITY_HEADERS_BUILD_FILE } from "@caelo-cms/shared";
import type { SiteCheck, StagedPage } from "./check.js";
import type { Finding } from "./findings.js";

export const SECURITY_HEADERS_CHECK_ID = "security-headers";

const LABEL = {
  "inline-handler": "Inline event handler",
  "javascript-url": "javascript: link",
  "data-script": "Script from a data: URL",
  "foreign-base": "<base> on another site",
} as const;

const HINT = {
  "inline-handler":
    "move the handler into the module's `js` (addEventListener on the module's root class) and remove the attribute from its html",
  "javascript-url": "use a real link or a button whose behaviour lives in the module's `js`",
  "data-script": "move the code into the module's `js`",
  "foreign-base": "remove the <base> element from the module's html",
} as const;

/** The page a build-relative file path belongs to. */
function pageOfFile(pages: readonly StagedPage[], file: string): StagedPage | undefined {
  const path = file.replace(/(?:\/index)?\.html$/, "").replace(/\/$/, "") || "/";
  return pages.find((p) => (p.path.replace(/\/$/, "") || "/") === path);
}

/** Build the core check. */
export function createSecurityHeadersCheck(): SiteCheck {
  return {
    id: SECURITY_HEADERS_CHECK_ID,
    title: "Security headers",
    scope: "site",
    async run({ pages, build }) {
      const text = await build.text(`/${SECURITY_HEADERS_BUILD_FILE}`);
      if (text === null) return [];
      const set = parseSiteHeaderSet(text);
      const severity = set.policy.cspMode === "enforce" ? "error" : "warning";
      const consequence =
        set.policy.cspMode === "enforce"
          ? "the site's Content Security Policy blocks it for every visitor"
          : "it would stop working if the Content Security Policy is enforced";
      const findings: Finding[] = [];
      for (const b of set.facts.blockers) {
        const page = b.pages[0] ? pageOfFile(pages, b.pages[0]) : undefined;
        findings.push({
          ruleId: `${SECURITY_HEADERS_CHECK_ID}/${b.kind}`,
          severity,
          ...(page ? { pageId: page.pageId } : {}),
          message:
            `${LABEL[b.kind]}: ${b.detail} on ${b.pageCount} page(s) such as ${b.pages[0] ?? "?"}: ${consequence}.`.slice(
              0,
              1000,
            ),
          fix: { tool: "update_modules_many", hint: HINT[b.kind] },
        });
      }
      if (set.cspCut) {
        findings.push({
          ruleId: `${SECURITY_HEADERS_CHECK_ID}/csp-too-large`,
          severity: "warning",
          message: `Content Security Policy too long: ${set.facts.inlineScriptHashes.length} inline scripts and the site's origins do not fit a response header, so parts of the test policy were left out and enforcing it would fail the build.`,
          fix: {
            tool: "update_modules_many",
            hint: "move inline <script> elements of modules into the module's `js`, then Stage again",
          },
        });
      }
      return findings;
    },
  };
}
