// SPDX-License-Identifier: MPL-2.0

/**
 * The plugin's skills. They go live with the plugin and archive with it
 * (CLAUDE.md §2) — a shipped capability the `## Skills` index never
 * announces is a capability nobody uses.
 *
 * Both are written in the operator's terms, because that is who the AI
 * is translating for: an operator asks for "the cookie thing" and "why
 * is the video not showing", never for a category or a guard.
 */

import type { PluginSkillSpec } from "@caelo-cms/plugin-sdk";

export const CONSENT_SKILLS: ReadonlyArray<PluginSkillSpec> = [
  {
    slug: "consent-banner-setup",
    displayName: "Set up the consent banner",
    description:
      "Build a GDPR consent dialog that matches the site's design, wired to the consent runtime.",
    body: [
      "The operator asks for a cookie banner, a consent dialog, or 'the GDPR thing'. They will not describe categories or attributes — that is your job.",
      "",
      "The split: the PLUGIN owns behaviour (recording the choice, holding tags and embeds back). YOU own everything visible — markup, copy, layout, colour. Never hand-write the consent logic in module JS; it is already there and it is the part that has to be right.",
      "",
      "Flow:",
      "1. Call consent_status FIRST. It returns the categories, the data list to iterate, and the exact attribute contract.",
      "2. Author ONE module for the banner and place it in the site LAYOUT — one placement covers every page. A per-page placement will miss the next page the operator adds.",
      "3. Iterate the categories rather than hard-coding four blocks:",
      '   <div data-consent-banner>{{#consent_categories}}<label><input type="checkbox" data-consent-category="{{key}}"> {{label}} <span>{{description}}</span></label>{{/consent_categories}}<button data-consent-accept-all>…</button><button data-consent-reject-all>…</button><button data-consent-save>…</button></div>',
      "4. Style it as part of the site: its own tokens, its own type scale. It should look like the footer belongs to the same site, not like a third-party widget.",
      "5. Declining must be exactly as easy as accepting — same prominence, same number of clicks. The runtime warns when data-consent-reject-all is missing, and a banner without it is not lawful consent.",
      "6. Add a data-consent-open link in the footer so visitors can change their mind later.",
      "7. Do NOT hide the banner yourself in CSS. The runtime decides when it is shown; a hand-rolled rule fights it and usually wins in the wrong direction.",
      "",
      "If the operator wants different wording or another language, use describe_categories — do not fork the copy into the module, or the two drift.",
      "",
      "When the operator asks to add analytics or a tracking pixel ('add Google Analytics', 'put the Meta pixel in'), use add_tracking_tag. Never paste a vendor snippet into a module: a tag in the page HTML has already run by the time anything could check consent. The tag surface pins it to a category and the runtime injects it only after that category is granted. The call pauses for the Owner's approval — say you prepared it, not that it is live.",
    ].join("\n"),
    allowlistedTools: [
      "consent_status",
      "describe_categories",
      "add_tracking_tag",
      "list_tracking_tags",
    ],
    autoEngagementHints: {
      keywords: ["cookie", "consent", "banner", "gdpr", "dsgvo", "tracking", "privacy"],
    },
  },
  {
    slug: "consent-embed-triage",
    displayName: "Handle third-party embeds",
    description:
      "Decide what happens to modules that load YouTube, Maps, fonts or pixels from someone else's server.",
    body: [
      "A module that embeds something from another company contacts that company the moment the page renders — before anyone agreed to anything. The plugin scans every module and withholds the ones that do, showing a placeholder instead until the visitor consents.",
      "",
      "You are involved in two situations.",
      "",
      "1. The operator asks why a video, map or embed shows a placeholder. Call list_external_embeds: it names the module, what it reaches for, and its status. Explain it in their terms — 'the video comes from YouTube, so it waits until visitors accept marketing cookies' — never in terms of guards or deferrals.",
      "",
      "2. A module is `pending`: the scanner found a vendor nobody has ruled on. It is withheld meanwhile, because unrecognised is not the same as harmless. Resolve it with classify_external_embed:",
      "   - pin it to a category when the vendor could identify the visitor (almost always the answer for anything embedded from a big platform);",
      "   - mark it allowed ONLY when the request carries nothing identifying — a self-hosted asset, a CDN that sets no cookies and logs no visitors.",
      "   When unsure, pin it. The cost of that mistake is a placeholder; the cost of the other is an unasked request to a third party.",
      "",
      "The placeholder is an ordinary module. If the operator does not like how it looks, restyle it like any other content — it is yours, not the plugin's. It needs a data-consent-accept-all or data-consent-open control so the visitor can act on it; without one it is a dead end.",
      "",
      "A YouTube embed can often be switched to youtube-nocookie.com, which is a functional embed rather than a marketing one. Offer that before pinning the module to marketing.",
    ].join("\n"),
    allowlistedTools: ["list_external_embeds", "classify_external_embed", "consent_status"],
    autoEngagementHints: {
      keywords: ["embed", "youtube", "video", "map", "iframe", "placeholder", "third-party"],
    },
  },
];
