// SPDX-License-Identifier: MPL-2.0

/**
 * Vendor templates — the tracking tags common enough that nobody should
 * hand-write their snippet (#1135).
 *
 * The operator knows "our Google Analytics id is G-ABC123"; they do not
 * know, and should not need to know, the JavaScript Google wants around
 * it. A template turns the validated ids into exactly the vendor's
 * published snippet, so the ids stay data: listed by `list_tags`,
 * validated on the way in, editable without touching code.
 *
 * Every snippet is copied from the vendor's own documentation (the URL
 * sits next to it) with only the placeholder replaced; the `<script>` and
 * `<noscript>` wrappers are dropped because the runtime injects the code
 * itself, and only after consent. Cookie lists and vendor data are the
 * vendor's documented defaults — the operator can override both per tag
 * when their setup differs (a renamed cookie prefix, a different
 * contracting entity).
 *
 * Categories are the conservative reading: anything that measures or
 * follows a visitor is never `necessary`.
 */

import type { CookieDecl, VendorInfo } from "./tags.js";

/** One validated config field: what it is called and what it must look like. */
interface ConfigField {
  /** The expected format, worded for the error message ("G- followed by letters and digits"). */
  readonly format: string;
  readonly test: (value: string) => boolean;
}

/** A known vendor: how to build its tag from validated ids. */
export interface VendorTemplate {
  readonly category: string;
  readonly note: string;
  /** Where the snippet below comes from. */
  readonly docUrl: string;
  readonly config: Readonly<Record<string, ConfigField>>;
  /** Builds the script URL and inline code from a config that passed `config`. */
  readonly build: (config: Readonly<Record<string, string>>) => { src: string; inline: string };
  readonly cookies: ReadonlyArray<CookieDecl>;
  readonly vendorInfo: VendorInfo;
}

/** Interpolated into JS as a string literal — every value is validated first, this is belt and braces. */
const js = (value: string): string => JSON.stringify(value);

const GOOGLE: VendorInfo = {
  name: "Google Ireland Limited",
  seat: "Gordon House, Barrow Street, Dublin 4, Ireland",
  thirdCountry: "USA",
  transferBasis: "EU-U.S. Data Privacy Framework (Google LLC is certified)",
  privacyPolicyUrl: "https://policies.google.com/privacy",
};

export const VENDOR_TEMPLATES: Readonly<Record<string, VendorTemplate>> = {
  "google-analytics": {
    category: "analytics",
    note: "Google Analytics 4. Pass config {measurementId: 'G-…'} (Admin → Data streams).",
    // gtag.js install snippet.
    docUrl: "https://developers.google.com/tag-platform/gtagjs/install",
    config: {
      measurementId: {
        format: "G- followed by letters and digits, e.g. G-ABC123XYZ9",
        test: (v) => /^G-[A-Z0-9]{4,20}$/.test(v),
      },
    },
    build: (c) => ({
      src: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(c.measurementId ?? "")}`,
      inline: [
        "window.dataLayer = window.dataLayer || [];",
        "function gtag(){dataLayer.push(arguments);}",
        "gtag('js', new Date());",
        `gtag('config', ${js(c.measurementId ?? "")});`,
      ].join("\n"),
    }),
    // https://support.google.com/analytics/answer/11397207
    cookies: [
      { name: "_ga", lifetime: "2 years", purpose: "Used to distinguish users." },
      {
        name: "_ga_",
        pattern: true,
        lifetime: "2 years",
        purpose: "Used to persist session state.",
      },
    ],
    vendorInfo: {
      ...GOOGLE,
      purpose: "Measures how visitors use the site (page views, sessions) in aggregate.",
    },
  },
  "google-tag-manager": {
    category: "marketing",
    note: "GTM can load anything, so it is treated as marketing — the strictest category its contents could need. Pass config {containerId: 'GTM-…'}. Declare the cookies of the tags GTM loads on this tag.",
    // The container snippet, as printed on the data layer guide.
    docUrl: "https://developers.google.com/tag-platform/tag-manager/datalayer",
    config: {
      containerId: {
        format: "GTM- followed by letters and digits, e.g. GTM-ABC1234",
        test: (v) => /^GTM-[A-Z0-9]{4,20}$/.test(v),
      },
    },
    build: (c) => ({
      src: "",
      inline: [
        "(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':",
        "new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],",
        "j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=",
        "'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);",
        `})(window,document,'script','dataLayer',${js(c.containerId ?? "")});`,
      ].join("\n"),
    }),
    // GTM itself sets no cookie; the tags it loads do.
    cookies: [],
    vendorInfo: {
      ...GOOGLE,
      purpose: "Loads the marketing and measurement tags configured in the site's tag container.",
    },
  },
  "meta-pixel": {
    category: "marketing",
    note: "Meta/Facebook pixel. Pass config {pixelId: '<digits>'} (Events Manager → Data sources).",
    docUrl: "https://developers.facebook.com/docs/meta-pixel/get-started",
    config: {
      pixelId: {
        format: "the numeric pixel id, digits only, e.g. 123456789012345",
        test: (v) => /^\d{6,20}$/.test(v),
      },
    },
    build: (c) => ({
      src: "",
      inline: [
        "!function(f,b,e,v,n,t,s)",
        "{if(f.fbq)return;n=f.fbq=function(){n.callMethod?",
        "n.callMethod.apply(n,arguments):n.queue.push(arguments)};",
        "if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';",
        "n.queue=[];t=b.createElement(e);t.async=!0;",
        "t.src=v;s=b.getElementsByTagName(e)[0];",
        "s.parentNode.insertBefore(t,s)}(window, document,'script',",
        "'https://connect.facebook.net/en_US/fbevents.js');",
        `fbq('init', ${js(c.pixelId ?? "")});`,
        "fbq('track', 'PageView');",
      ].join("\n"),
    }),
    // https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc/
    cookies: [
      {
        name: "_fbp",
        lifetime: "90 days",
        purpose: "Identifies the browser for Meta advertising measurement.",
      },
      {
        name: "_fbc",
        lifetime: "90 days",
        purpose: "Stores the click id of a visit that came from a Meta ad.",
      },
    ],
    vendorInfo: {
      name: "Meta Platforms Ireland Limited",
      seat: "Merrion Road, Dublin 4, D04 X2K5, Ireland",
      purpose: "Measures the effect of advertising on Meta and builds audiences for it.",
      thirdCountry: "USA",
      transferBasis: "EU-U.S. Data Privacy Framework (Meta Platforms, Inc. is certified)",
      privacyPolicyUrl: "https://www.facebook.com/privacy/policy/",
    },
  },
  matomo: {
    category: "analytics",
    note: "Matomo (self-hosted or Matomo Cloud). Pass config {trackerUrl: 'https://<your matomo>/', siteId: '<digits>'}. Fill vendorInfo with whoever runs the Matomo server. Cookie-less mode may qualify as necessary — document it in the justification if you claim that.",
    docUrl: "https://developer.matomo.org/guides/tracking-javascript-guide",
    config: {
      trackerUrl: {
        format: "the https URL of the Matomo installation, e.g. https://analytics.example.com/",
        test: (v) => {
          try {
            const u = new URL(v);
            return u.protocol === "https:" && u.search === "" && u.hash === "" && !u.username;
          } catch {
            return false;
          }
        },
      },
      siteId: { format: "the numeric site id, e.g. 1", test: (v) => /^\d{1,9}$/.test(v) },
    },
    build: (c) => {
      const base = (c.trackerUrl ?? "").endsWith("/") ? (c.trackerUrl ?? "") : `${c.trackerUrl}/`;
      return {
        src: "",
        inline: [
          "var _paq = window._paq = window._paq || [];",
          "_paq.push(['trackPageView']);",
          "_paq.push(['enableLinkTracking']);",
          "(function() {",
          `  var u=${js(base)};`,
          "  _paq.push(['setTrackerUrl', u+'matomo.php']);",
          `  _paq.push(['setSiteId', ${js(c.siteId ?? "")}]);`,
          "  var d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];",
          "  g.type='text/javascript'; g.async=true; g.src=u+'matomo.js'; s.parentNode.insertBefore(g,s);",
          "})();",
        ].join("\n"),
      };
    },
    // https://matomo.org/faq/general/faq_146/ — the names carry a
    // `.<site id>.<hash>` suffix, hence prefixes.
    cookies: [
      {
        name: "_pk_id",
        pattern: true,
        lifetime: "13 months",
        purpose: "Stores a unique visitor id.",
      },
      {
        name: "_pk_ses",
        pattern: true,
        lifetime: "30 minutes",
        purpose: "Temporarily stores data for the visit.",
      },
      {
        name: "_pk_ref",
        pattern: true,
        lifetime: "6 months",
        purpose: "Stores the referrer that brought the visitor to the site.",
      },
    ],
    vendorInfo: {
      purpose: "Measures how visitors use the site (page views, visits, referrers).",
    },
  },
  hotjar: {
    category: "analytics",
    note: "Hotjar session recording and heatmaps. Pass config {siteId: '<digits>'}. Record the retention period in the vendor's settings and in the privacy policy.",
    // The snippet Hotjar's own browser package injects (@hotjar/browser
    // 1.0.9, github.com/hotjar/hotjar-js), snippet version 6 as its README
    // passes it. Hotjar's help centre blocks automated reads.
    docUrl: "https://github.com/hotjar/hotjar-js",
    config: {
      siteId: {
        format: "the numeric Hotjar site id (hjid), e.g. 1234567",
        test: (v) => /^\d{3,12}$/.test(v),
      },
    },
    build: (c) => ({
      src: "",
      inline: [
        "(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};",
        `h._hjSettings={hjid:${Number(c.siteId)},hjsv:6};`,
        "a=o.getElementsByTagName('head')[0];r=o.createElement('script');r.async=1;",
        "r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);",
        "})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');",
      ].join("\n"),
    }),
    // Hotjar's cookie article (help.hotjar.com/hc/en-us/articles/6952777582999)
    // could not be fetched when this was written; these are its long-standing
    // defaults. The names end in the site id, hence prefixes.
    cookies: [
      {
        name: "_hjSessionUser_",
        pattern: true,
        lifetime: "365 days",
        purpose: "Keeps the Hotjar user id across visits.",
      },
      {
        name: "_hjSession_",
        pattern: true,
        lifetime: "30 minutes",
        purpose: "Keeps the current session's data together.",
      },
    ],
    vendorInfo: {
      name: "Hotjar Ltd (a Contentsquare company)",
      purpose: "Records how visitors use pages (clicks, scrolling, session recordings).",
    },
  },
  leadinfo: {
    category: "marketing",
    note: "Leadinfo B2B visitor identification. Pass config {accountId: 'LI-…'} (portal → Settings → Trackers).",
    // The snippet Leadinfo's own WordPress plugin prints (leadinfo 2.1.4,
    // leadinfo.class.php); its id check is the format below.
    docUrl: "https://wordpress.org/plugins/leadinfo/",
    config: {
      accountId: {
        format: "LI- followed by digits and capital letters, e.g. LI-1234567890",
        test: (v) => /^LI-[0-9A-Z]+$/.test(v),
      },
    },
    build: (c) => ({
      src: "",
      inline: [
        "(function (l, e, a, d, i, n, f, o) {",
        "  if (!l[i]) {",
        "    l.GlobalLeadinfoNamespace = l.GlobalLeadinfoNamespace || [];",
        "    l.GlobalLeadinfoNamespace.push(i);",
        "    l[i] = function () { (l[i].q = l[i].q || []).push(arguments) };",
        "    l[i].t = l[i].t || n;",
        "    l[i].q = l[i].q || [];",
        "    o = e.createElement(a);",
        "    f = e.getElementsByTagName(a)[0];",
        "    o.async = 1;",
        "    o.src = d;",
        "    f.parentNode.insertBefore(o, f);",
        "  }",
        `}(window, document, "script", "https://cdn.leadinfo.net/ping.js", "leadinfo", ${js(c.accountId ?? "")}));`,
      ].join("\n"),
    }),
    // help.leadinfo.com/en/add-leadinfo-to-your-cookie-banner-solution. The
    // Leadinfo help pages disagree on which of the two is the session one;
    // the operator should confirm in the browser. Names carry a suffix.
    cookies: [
      {
        name: "_li_id",
        pattern: true,
        lifetime: "2 years",
        purpose: "Recognises a returning visitor.",
      },
      {
        name: "_li_ses",
        pattern: true,
        lifetime: "Session",
        purpose: "Links the pages visited in one session.",
      },
    ],
    vendorInfo: {
      name: "Leadinfo B.V.",
      seat: "Rivium Quadrant 141, 2909 LC Capelle aan den IJssel, the Netherlands",
      purpose: "Identifies which companies visit the site, from the visitor's IP address.",
      thirdCountry: "",
      privacyPolicyUrl: "https://www.leadinfo.com/en/legal/privacy/",
    },
  },
};

/**
 * Validate a known vendor's config. The error names every field with its
 * expected format, so the AI can ask the operator for exactly that.
 */
export function parseVendorConfig(
  tool: string,
  vendor: string,
  template: VendorTemplate,
  config: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const expected = Object.entries(template.config)
    .map(([k, f]) => `${k} (${f.format})`)
    .join(", ");
  const given = config ?? {};
  const unknown = Object.keys(given).filter((k) => !(k in template.config));
  if (unknown.length > 0) {
    throw new Error(
      `${tool}: ${vendor} takes config ${expected}; unknown key(s): ${unknown.join(", ")}`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, field] of Object.entries(template.config)) {
    const value = (given[key] ?? "").trim();
    if (!field.test(value)) {
      throw new Error(
        `${tool}: ${vendor} needs config.${key} as ${field.format}${value ? ` — got "${value}"` : ""}. Ask the operator for it if you do not have it; do not hand-write the vendor's snippet instead.`,
      );
    }
    out[key] = value;
  }
  return out;
}
