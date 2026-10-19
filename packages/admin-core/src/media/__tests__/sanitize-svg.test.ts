// SPDX-License-Identifier: MPL-2.0

/**
 * Regression tests for `sanitizeSvg` — issue #113 (S6, js/bad-tag-filter +
 * js/incomplete-multi-character-sanitization) and PR #863 (H-04). Every
 * "strips" case below is a payload the earlier regex denylist let through;
 * the "keeps" cases pin the legitimate content an allowlist must not lose.
 */

import { describe, expect, it } from "bun:test";
import { sanitizeSvg } from "../sanitize-svg.js";

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** True when nothing executable is left in `out` (case-insensitive). */
function inert(out: string): boolean {
  const l = out.toLowerCase();
  return (
    !l.includes("script") &&
    !l.includes("onload") &&
    !l.includes("onclick") &&
    !l.includes("<iframe") &&
    !l.includes("<embed") &&
    !l.includes("foreignobject") &&
    !l.includes("<!doctype") &&
    !l.includes("<!entity") &&
    !l.includes("<?xml-stylesheet")
  );
}

describe("sanitizeSvg — strips executable content", () => {
  it("removes a simple <script> element", () => {
    expect(sanitizeSvg(`<svg ${NS}><script>alert(1)</script></svg>`)).toBe(`<svg ${NS}></svg>`);
  });

  it("removes a split-injection that a single pass would re-create", () => {
    const out = sanitizeSvg("<svg><scr<script>x</script>ipt>alert(1)</script></svg>");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  it("matches the </script\\t\\n bar> end-tag variant (bad-tag-filter)", () => {
    expect(sanitizeSvg("<svg><script>x</script\t\n bar></svg>")).not.toContain("<script");
  });

  it("drops case variants and namespaced script, including prefixes with dots", () => {
    for (const dirty of [
      "<svg><Script>alert(1)</Script></svg>",
      "<svg><SCRIPT>alert(1)</SCRIPT></svg>",
      '<svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg>',
      "<svg><SVG:SCRIPT>alert(1)</SVG:SCRIPT></svg>",
      '<svg><a.b:script xmlns:a.b="http://www.w3.org/2000/svg">alert(1)</a.b:script></svg>',
      '<svg><html:script xmlns:html="http://www.w3.org/1999/xhtml">alert(1)</html:script></svg>',
      "<svg><script><![CDATA[alert(1)]]></script></svg>",
    ]) {
      const out = sanitizeSvg(dirty);
      expect(inert(out)).toBe(true);
      expect(out).not.toContain("alert");
    }
  });

  it("drops DTD entities that would expand to markup or to a javascript: link", () => {
    const markup = sanitizeSvg(
      `<!DOCTYPE svg [<!ENTITY s "&#60;script&#62;alert(1)&#60;/script&#62;">]><svg ${NS}>&s;</svg>`,
    );
    expect(inert(markup)).toBe(true);
    expect(markup).toBe(`<svg ${NS}>&amp;s;</svg>`);

    const link = sanitizeSvg(
      `<!DOCTYPE svg [<!ENTITY j "javascript:alert(1)">]><svg ${NS}><a href="&j;">x</a></svg>`,
    );
    expect(link).not.toContain("javascript");
    // The undeclared reference is now literal text, not an entity.
    expect(link).toContain('href="&amp;j;"');
  });

  it("drops <?xml-stylesheet?> (XSLT) and comments", () => {
    const out = sanitizeSvg(
      `<?xml-stylesheet type="text/xsl" href="data:text/xsl,x"?><svg ${NS}><!-- <script>x</script> --></svg>`,
    );
    expect(out).toBe(`<svg ${NS}></svg>`);
  });

  it("drops foreignObject and XHTML iframe / embed / object outside it", () => {
    const out = sanitizeSvg(
      `<svg ${NS}>` +
        '<foreignObject><iframe srcdoc="&lt;script&gt;alert(2)&lt;/script&gt;"></iframe></foreignObject>' +
        '<iframe xmlns="http://www.w3.org/1999/xhtml" src="javascript:alert(3)"/>' +
        '<html:embed xmlns:html="http://www.w3.org/1999/xhtml" src="javascript:alert(4)"/>' +
        '<object data="javascript:alert(5)"/>' +
        "</svg>",
    );
    expect(out).toBe(`<svg ${NS}></svg>`);
  });

  it("strips on* handlers in any case, quoting or adjacency", () => {
    for (const dirty of [
      '<svg onload="x()"/>',
      '<svg ONLOAD="x()"/>',
      '<svg onLoad="x()"/>',
      "<svg onload=x()/>",
      '<svg x="1"onload="x()"/>',
      '<svg><rect onclick="x()" width="1"/></svg>',
    ]) {
      expect(inert(sanitizeSvg(dirty))).toBe(true);
    }
  });

  it("strips javascript:/vbscript:/non-image data: links however they are spelled", () => {
    for (const href of [
      "javascript:alert(1)",
      "  javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\nscript:alert(1)",
      "java\tscript:alert(1)",
      "&#106;avascript:alert(1)",
      "&#x6A;avascript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;",
      "data:image/svg+xml;base64,PHN2Zz4=",
    ]) {
      for (const attr of ["href", "xlink:href", "HREF"]) {
        const out = sanitizeSvg(`<svg ${NS}><a ${attr}="${href}">x</a></svg>`);
        expect(out).toBe(`<svg ${NS}><a>x</a></svg>`);
      }
    }
    // Unquoted.
    expect(sanitizeSvg("<svg><a href=javascript:alert(1)>x</a></svg>")).not.toContain("javascript");
  });

  it("drops SMIL that retargets a link or a handler, keeps decorative animation", () => {
    for (const dirty of [
      '<svg><a><set attributeName="href" to="javascript:alert(1)"/>x</a></svg>',
      '<svg><a><animate attributeName="xlink:href" values="javascript:alert(1)"/>x</a></svg>',
      '<svg><set attributeName="onload" to="alert(1)"/></svg>',
      '<svg><set attributeName=" HREF " to="javascript:alert(1)"/></svg>',
    ]) {
      const out = sanitizeSvg(dirty);
      expect(out).not.toContain("<set");
      expect(out).not.toContain("<animate");
    }
    const spin = `<svg ${NS}><rect><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s"/></rect></svg>`;
    expect(sanitizeSvg(spin)).toBe(spin);
  });

  it("drops xml:base, foreign namespace declarations and their attributes", () => {
    const out = sanitizeSvg(
      `<svg ${NS} xmlns:ev="http://www.w3.org/2001/xml-events" xml:base="javascript:/"><rect ev:event="click" xml:space="preserve"/></svg>`,
    );
    expect(out).toBe(`<svg ${NS}><rect xml:space="preserve"/></svg>`);
  });
});

describe("sanitizeSvg — keeps legitimate content", () => {
  it("leaves a clean SVG untouched", () => {
    const clean = `<svg ${NS} viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`;
    expect(sanitizeSvg(clean)).toBe(clean);
  });

  it("keeps embedded raster images, fragment, relative and https links", () => {
    const svg =
      `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink">` +
      '<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>' +
      '<image xlink:href="data:image/jpeg;base64,/9j/4AAQ" width="1" height="1"/>' +
      '<use href="#icon"/><use xlink:href="sprite.svg#a"/>' +
      '<a href="https://example.com/?a=1&amp;b=2">x</a>' +
      "</svg>";
    expect(sanitizeSvg(svg)).toBe(svg);
  });

  it("keeps gradients, filters, styles and text (CSS child combinator included)", () => {
    const svg =
      `<svg ${NS}><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient>` +
      '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs>' +
      "<style>.a &gt; .b { fill: url(#g); }</style>" +
      '<text x="1" y="2"><tspan>Hi &amp; bye</tspan></text></svg>';
    expect(sanitizeSvg(svg)).toBe(svg);
  });

  it("adds the namespaces back when DTD entities carried them (Illustrator exports)", () => {
    const illustrator =
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [' +
      '<!ENTITY ns_svg "http://www.w3.org/2000/svg"><!ENTITY ns_xlink "http://www.w3.org/1999/xlink">]>' +
      '<svg xmlns="&ns_svg;" xmlns:xlink="&ns_xlink;"><use xlink:href="#a"/></svg>';
    expect(sanitizeSvg(illustrator)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>',
    );
  });

  it("drops editor metadata subtrees without touching the drawing", () => {
    const out = sanitizeSvg(
      `<svg ${NS} xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" inkscape:version="1.3">` +
        '<sodipodi:namedview id="n"><inkscape:grid/></sodipodi:namedview>' +
        '<metadata><rdf:RDF><cc:Work/></rdf:RDF></metadata><path d="M0 0h1"/></svg>',
    );
    expect(out).toBe(`<svg ${NS}><path d="M0 0h1"/></svg>`);
  });

  it("is idempotent", () => {
    const dirty =
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg><script>a</script><rect onclick="b()"/><a href="java\nscript:x">&x;</a></svg>';
    const once = sanitizeSvg(dirty);
    expect(sanitizeSvg(once)).toBe(once);
  });
});
