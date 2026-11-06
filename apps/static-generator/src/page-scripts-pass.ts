// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1454 — the composer's page script becomes a file on a deployed page.
 *
 * The composer joins the JS of a page's modules into one
 * `<script defer data-source="modules">`. Inline, a site's CSP could only
 * allow it by hash, one per distinct set of modules: on a 50,000-page site
 * that does not fit a response header, and `'unsafe-inline'` would allow any
 * injected script too. As a content-hashed file `'self'` covers every page.
 * Identical module sets share one file, which browsers cache for a year
 * (the name matches CONTENT_HASHED_PATH_PATTERN).
 *
 * A body that cannot sit in an HTML element reaches this pass as a base64
 * `data:` URL, which a CSP without `data:` would refuse: the file replaces
 * that form too. The preview keeps the inline form: it is the admin's
 * document and carries none of the site's headers.
 */

import { createHash } from "node:crypto";

const INLINE_RE = /<script defer data-source="modules">([\s\S]*?)<\/script>/g;
const ENCODED_RE =
  /<script defer data-source="modules" src="data:text\/javascript;base64,([A-Za-z0-9+/=]*)"><\/script>/g;

/** Build-relative path of the page script with this body. */
export function pageScriptPath(body: string): string {
  const hash = createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
  return `_assets/page-script.${hash}.js`;
}

/** A page the pass rewrites in place. */
export interface ScriptPage {
  html: string;
}

/** Moves page scripts into files, each distinct body once per build. */
export class PageScripts {
  readonly #written = new Set<string>();
  readonly #write: (relPath: string, content: string) => Promise<void>;

  /** @param write puts one file into the build. */
  constructor(write: (relPath: string, content: string) => Promise<void>) {
    this.#write = write;
  }

  /** How many files the pass wrote so far. */
  get fileCount(): number {
    return this.#written.size;
  }

  /** Replace every page's inline module script by a reference to its file. */
  async externalize(pages: readonly ScriptPage[]): Promise<void> {
    const pending = new Map<string, string>();
    const reference = (body: string): string => {
      const relPath = pageScriptPath(body);
      if (!this.#written.has(relPath)) pending.set(relPath, body);
      return `<script defer data-source="modules" src="/${relPath}"></script>`;
    };
    for (const page of pages) {
      page.html = page.html
        .replace(INLINE_RE, (_m, body: string) => reference(body))
        .replace(ENCODED_RE, (_m, encoded: string) =>
          reference(Buffer.from(encoded, "base64").toString("utf8")),
        );
    }
    for (const [relPath, body] of pending) {
      await this.#write(relPath, body);
      this.#written.add(relPath);
    }
  }
}
