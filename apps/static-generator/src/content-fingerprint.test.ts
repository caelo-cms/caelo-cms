// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  bodyContentDigest,
  pageContentFingerprint,
  visibleContent,
} from "./content-fingerprint.js";

describe("visibleContent", () => {
  it("keeps text, link targets, image sources and alternative texts", () => {
    expect(
      visibleContent(
        '<section class="hero"><h1>Hello &amp; welcome</h1><a href="/about" class="btn">About</a><img src="/_caelo/media/x" alt="A cat"></section>',
      ),
    ).toBe("Hello & welcome \u0001href=/about About \u0001src=/_caelo/media/x \u0001alt=A cat");
  });

  it("ignores markup, classes, styles, scripts and whitespace runs", () => {
    const a = '<div class="a"><p>One   two</p><script>track()</script><style>p{}</style></div>';
    const b = '<section data-x="1" style="color:red">\n  <p class="b">One two</p>\n</section>';
    expect(visibleContent(a)).toBe(visibleContent(b));
  });
});

describe("pageContentFingerprint", () => {
  const body = bodyContentDigest("<main><p>Prices from 10 EUR</p></main>");

  it("is a sha256 hex digest", () => {
    expect(pageContentFingerprint({ title: "T", metaDescription: "D", bodyDigest: body })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("moves with the title, the description and the body text", () => {
    const base = pageContentFingerprint({ title: "T", metaDescription: "D", bodyDigest: body });
    expect(
      pageContentFingerprint({ title: "T2", metaDescription: "D", bodyDigest: body }),
    ).not.toBe(base);
    expect(
      pageContentFingerprint({ title: "T", metaDescription: "D2", bodyDigest: body }),
    ).not.toBe(base);
    const other = bodyContentDigest("<main><p>Prices from 12 EUR</p></main>");
    expect(
      pageContentFingerprint({ title: "T", metaDescription: "D", bodyDigest: other }),
    ).not.toBe(base);
  });

  it("moves with the <title> and the page title both, and is unchanged while they agree (#1752)", () => {
    const base = pageContentFingerprint({ title: "T", metaDescription: "D", bodyDigest: body });
    expect(
      pageContentFingerprint({
        title: "T",
        metaDescription: "D",
        bodyDigest: body,
        headTitle: "T",
      }),
    ).toBe(base);
    const own = pageContentFingerprint({
      title: "T",
      metaDescription: "D",
      bodyDigest: body,
      headTitle: "Own title",
    });
    expect(own).not.toBe(base);
    // A fixed own <title>: a new page title still moves the date.
    expect(
      pageContentFingerprint({
        title: "T2",
        metaDescription: "D",
        bodyDigest: body,
        headTitle: "Own title",
      }),
    ).not.toBe(own);
  });

  it("stays when only the markup around the same content changes", () => {
    const restyled = bodyContentDigest(
      '<main class="new"><p class="lead">Prices from 10 EUR</p></main>',
    );
    expect(restyled).toBe(body);
  });
});
