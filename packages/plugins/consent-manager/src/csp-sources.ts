// SPDX-License-Identifier: MPL-2.0

/**
 * What the consent runtime reaches, for the site's CSP (#1454).
 *
 * No tag is in a page's markup: the runtime injects it after consent, so the
 * build cannot read it there. This file tells the build instead, as the
 * reserved `csp-sources.json` of `buildAssets`: the exact text of every
 * inline snippet (the build hashes it), the origin of every tag's script and
 * the hosts a known vendor's script goes on to contact. An Owner's tag is an
 * approved decision (`add_tracking_tag`), which is why it may widen the CSP.
 *
 * Vendor hosts follow the vendors' CSP guidance. Google's:
 * https://developers.google.com/tag-platform/security/guides/csp
 * A tag container can load anything, so GTM's list covers the container and
 * Google's own measurement; what else it loads shows as a report-only
 * violation, and the Owner adds it to the policy's `extraSources`.
 */

import type { BakedTag } from "./tags.js";

type Kind = "script" | "connect" | "img" | "frame";

const GOOGLE_TAGS: Readonly<Partial<Record<Kind, readonly string[]>>> = {
  script: ["https://*.googletagmanager.com"],
  connect: [
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
    "https://*.googletagmanager.com",
  ],
  img: ["https://*.google-analytics.com", "https://*.googletagmanager.com"],
};

const VENDOR_ORIGINS: Readonly<Record<string, Readonly<Partial<Record<Kind, readonly string[]>>>>> =
  {
    "google-analytics": GOOGLE_TAGS,
    "google-tag-manager": GOOGLE_TAGS,
    "meta-pixel": {
      script: ["https://connect.facebook.net"],
      connect: ["https://www.facebook.com"],
      img: ["https://www.facebook.com"],
    },
    hotjar: {
      script: ["https://*.hotjar.com"],
      connect: ["https://*.hotjar.com", "https://*.hotjar.io", "wss://*.hotjar.com"],
      img: ["https://*.hotjar.com"],
      frame: ["https://*.hotjar.com"],
    },
    leadinfo: {
      script: ["https://*.leadinfo.net"],
      connect: ["https://*.leadinfo.net"],
      img: ["https://*.leadinfo.net"],
    },
  };

const ORIGIN_IN_SNIPPET_RE = /https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?/gi;
/** What the build accepts as an origin; snippet text can hold anything else. */
const VALID_ORIGIN_RE =
  /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?(:\d{1,5})?$/;

/** The `csp-sources.json` of a build with these tags. */
export function tagCspSources(tags: readonly BakedTag[]): {
  origins: Record<Kind, string[]>;
  inlineScripts: string[];
} {
  const origins: Record<Kind, Set<string>> = {
    script: new Set(),
    connect: new Set(),
    img: new Set(),
    frame: new Set(),
  };
  const inlineScripts = new Set<string>();
  for (const tag of tags) {
    for (const [kind, list] of Object.entries(VENDOR_ORIGINS[tag.vendor] ?? {})) {
      for (const origin of list) origins[kind as Kind].add(origin);
    }
    if (tag.src) {
      const origin = new URL(tag.src).origin.toLowerCase();
      if (VALID_ORIGIN_RE.test(origin)) origins.script.add(origin);
    }
    if (tag.inline) {
      inlineScripts.add(tag.inline);
      // A snippet's own host loads the vendor's script and takes its hits
      // (Matomo's tracker, any unknown vendor).
      for (const m of tag.inline.matchAll(ORIGIN_IN_SNIPPET_RE)) {
        const origin = m[0].toLowerCase();
        if (!VALID_ORIGIN_RE.test(origin)) continue;
        origins.script.add(origin);
        origins.connect.add(origin);
        origins.img.add(origin);
      }
    }
  }
  return {
    origins: {
      script: [...origins.script].sort(),
      connect: [...origins.connect].sort(),
      img: [...origins.img].sort(),
      frame: [...origins.frame].sort(),
    },
    inlineScripts: [...inlineScripts].sort(),
  };
}
