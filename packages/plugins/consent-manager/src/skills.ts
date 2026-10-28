// SPDX-License-Identifier: MPL-2.0

/**
 * The plugin's skills. They go live with the plugin and archive with it
 * (CLAUDE.md §2) — a shipped capability the `## Skills` index never
 * announces is a capability nobody uses.
 *
 * Both are written in the operator's terms, because that is who the AI
 * is translating for: an operator asks for "the cookie thing" and "why
 * is the video not showing", never for a category or a guard (CLAUDE.md
 * §1A). The setup skill is a guided flow (#1130) because consent touches
 * five things at once — tools, embeds, the banner, the cookie
 * declaration and the privacy policy — and an operator left to discover
 * them one at a time ends up with a banner that is not lawful.
 */

import type { PluginSkillSpec } from "@caelo-cms/plugin-sdk";

export const CONSENT_SKILLS: ReadonlyArray<PluginSkillSpec> = [
  {
    slug: "consent-banner-setup",
    displayName: "Set up consent and cookies",
    description:
      "Guided consent setup: ask what the site measures and embeds, register the tracking tools, build a lawful banner that matches the design, and prepare the cookie declaration and privacy-policy facts.",
    body: [
      "The operator asks for a cookie banner, 'the GDPR thing', analytics, or has just switched consent on. They will not talk about categories, tags, modules or attributes — that is your job. Run this as a short guided setup, in their words.",
      "",
      "Do what they asked for in this turn, and OFFER the rest. 'Build a cookie banner' means steps 1, 3 (for tools they named), 4 and 5; the cookie declaration and the privacy-policy draft (step 6) are offered at the end, not built unasked — they touch pages the operator did not mention.",
      "",
      "The split: the PLUGIN owns behaviour (recording the choice, holding tags and embeds back, deleting cookies on withdrawal). YOU own everything visible — markup, copy, layout, colour. Never hand-write consent logic in module JS; it already exists and it is the part that has to be right.",
      "",
      "## 1. Look before you ask",
      "Call consent_status. If `withheldNow` lists anything, tell the operator FIRST, plainly: 'Your header is hidden from visitors right now because it loads something from www.example.com — I will sort that out.' `siteChrome: true` means a header, footer or menu is missing on every page; resolve those before anything else (see the embed skill: classify_external_embed / allow_external_embed). Then call list_tracking_tags and list_external_embeds so you know what is already there.",
      "",
      "## 2. Ask about goals, not mechanics — one short message",
      "- Do you want visitor statistics? Which tool (Google Analytics, Matomo, Hotjar …) and its id?",
      "- Marketing or advertising tools (Meta pixel, Google Tag Manager, Leadinfo, LinkedIn …)? Their ids?",
      "- Should any of them run only on some pages or in one language (e.g. only German product pages)?",
      "- Which embeds do visitors see (videos, maps, social posts)? You can see most of these yourself in list_external_embeds — confirm, do not interrogate.",
      "- How should the banner look: a bar along the bottom, a small box in a corner, or a dialog in the middle? Offer the one that fits the design as the default.",
      "Skip any question the operator already answered in their request, and skip the whole step when they named their tools. If the site uses none of these, say so: then the banner only informs about the necessary cookie, and that is fine.",
      "",
      "## 3. Register the tools",
      "One add_tracking_tag per tool. For known vendors (google-analytics, google-tag-manager, meta-pixel, matomo, hotjar, leadinfo) pass `vendor` + `config` with the id — never paste the vendor's snippet. Page or language limits go into `scope` (paths like '/de/*', page or template ids, locales). Each call pauses for the operator's approval; say that approving it asks every visitor for consent again, because their earlier consent did not cover the new tool. Batch later changes into one update_tags_many.",
      "When a result lists `declarationGaps` (missing vendor address, privacy link, transfer basis …), ask the operator for exactly those and fill them with update_tags_many.",
      "",
      "## 4. Classify every embed",
      "Anything `pending` in list_external_embeds is withheld until you decide (see the embed skill). Prefer privacy-friendly variants first (youtube-nocookie.com), then pin to a category.",
      "",
      "## 5. Build the banner",
      'ONE module, placed in the site LAYOUT — one placement covers every page. Iterate the list the plugin provides instead of hard-coding categories; it already contains only the categories this site uses, plus the required one. Declare NO field for it (a declared one would be {kind:"list", bind:"source", source:{kind:"plugin", name:"consent_categories"}} — never kind "system"):',
      '   <div data-consent-banner role="dialog" aria-label="…">{{#consent_categories}}<label><input type="checkbox" data-consent-category="{{key}}"> {{label}} <span>{{description}}</span></label>{{/consent_categories}}<button data-consent-accept-all>…</button><button data-consent-reject-all>…</button><button data-consent-save>…</button></div>',
      "Lawful-banner rules, all of them:",
      "- Reject is on the FIRST layer, next to Accept, with the same size, colour weight and number of clicks. No 'reject' hidden behind 'settings'.",
      "- Nothing optional is pre-ticked; the required category is shown as always on.",
      "- Each category says in one sentence what it is for (describe_categories rewords them; do not fork the copy into the module).",
      "- Link the privacy policy from the banner — by the path of the existing privacy page (list_pages). If there is none yet, leave the link out and tell the operator; a link to a page that does not exist is refused.",
      "- A data-consent-open link in the footer lets visitors change their mind; the runtime moves focus into the banner, closes it on Escape and returns focus.",
      "- Do NOT hide or show the banner yourself in CSS; give its root whatever display (flex, grid) the layout needs — the runtime only hides it when no choice is due.",
      "- Style it as part of the site: its tokens, its type scale.",
      "",
      "## 6. Cookie declaration and privacy policy",
      'When the operator wants it: on the privacy page, add a cookie declaration module that iterates {{#consent_vendors}}. Like consent_categories, declare NO field for it. Each entry carries category, category_label, category_first (true on the first entry of a category: wrap the group heading in {{#category_first}}…{{/category_first}}), kind, vendor, vendor_seat, purpose, legal_basis, third_country, transfer_basis, privacy_policy (a link: href="{{privacy_policy}}"), cookies (one summary line) and updated (a date). Every one of these exists only INSIDE the loop — {{updated}} outside {{#consent_vendors}} is an undeclared field; show the date inside the loop, e.g. next to the first heading. It stays current by itself when tags change.',
      "Then tell the operator what their privacy policy must contain, and offer to draft it: who is responsible (name, address, contact; a data protection officer if they have one); that a consent banner is used and how to change the choice; the proof-of-consent record — copy `consentLog.privacyPolicyText` from consent_status, it states exactly what is stored and for how long; each tool with recipient, purpose, legal basis, storage period and any transfer outside the EU and its basis (the declaration covers this); embedded third-party content; the visitor's rights (access, correction, deletion, restriction, objection, portability, withdrawal of consent, complaint to a supervisory authority). Point out that legal review is theirs to arrange — you prepare, you do not certify.",
      "",
      "## 7. Close the loop",
      "Summarise in operator terms what visitors will now see and what runs after which choice. When they later ask how many visitors agree, use consent_stats; the individual consent records are personal data and stay in the admin's consent panel.",
    ].join("\n"),
    allowlistedTools: [
      "consent_status",
      "describe_categories",
      "add_tracking_tag",
      "update_tags_many",
      "list_tracking_tags",
      "list_external_embeds",
      "classify_external_embed",
      "allow_external_embed",
      "consent_stats",
    ],
    autoEngagementHints: {
      keywords: [
        "cookie",
        "consent",
        "banner",
        "gdpr",
        "dsgvo",
        "tracking",
        "privacy",
        "analytics",
        "datenschutz",
      ],
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
      "1. The operator asks why a video, map, header or footer shows a placeholder, or consent_status lists it in `withheldNow`. Call list_external_embeds: it names the module, what it reaches for, and its status. Explain it in their terms — 'the video comes from YouTube, so it waits until visitors accept marketing cookies' — never in terms of guards or deferrals.",
      "",
      "2. A module is `pending`: the scanner found a vendor nobody has ruled on. It is withheld meanwhile, because unrecognised is not the same as harmless. Resolve it:",
      "   - classify_external_embed pins it to a category when the vendor could identify the visitor (almost always the answer for anything embedded from a big platform);",
      "   - allow_external_embed lets it render for everyone ONLY when the request carries nothing identifying — a self-hosted asset, a CDN that sets no cookies and logs no visitors — or only the visitor's own action sends it. That waits for the Owner's Approve: tell them which hosts and why, and that the module stays hidden until they approve.",
      "   When unsure, pin it. The cost of that mistake is a placeholder; the cost of the other is an unasked request to a third party.",
      "",
      "The placeholder is an ordinary module. If the operator does not like how it looks, restyle it like any other content — it is yours, not the plugin's. It needs a data-consent-accept-all or data-consent-open control so the visitor can act on it; without one it is a dead end.",
      "",
      "A YouTube embed can often be switched to youtube-nocookie.com, which is a functional embed rather than a marketing one. Offer that before pinning the module to marketing.",
    ].join("\n"),
    allowlistedTools: [
      "list_external_embeds",
      "classify_external_embed",
      "allow_external_embed",
      "consent_status",
    ],
    autoEngagementHints: {
      keywords: ["embed", "youtube", "video", "map", "iframe", "placeholder", "third-party"],
    },
  },
];
