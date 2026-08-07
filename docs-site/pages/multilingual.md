---
slug: multilingual
template: doc-page
status: published
seo:
  title: Multilingual sites — Caelo CMS
  description: Add languages by chatting. The international-site plugin handles variants, context-aware translation, localized URLs, hreflang, and the language selector.
---

# Multilingual sites

Caelo's i18n is a first-party plugin, not a core subsystem: activate `international-site` and the site gains languages; uninstall it and your pages keep working at their final URLs. Everything below happens by chatting — the AI drives the plugin's tools, and you approve the few clicks that change URLs site-wide.

## Adding a language

Say *"add German to the site"*. The AI drafts the locale registry — language, display name, URL shape — and the turn pauses on an approval card in the chat. Two decisions ride on that click:

- **URL strategy.** `subdirectory` (`/de/preise`) is the safe default. `subdomain` (`de.example.com`) and `domain` (`example.de`) are available when you own the hosts.
- **Default language.** Exactly one locale is the default; its pages keep their bare URLs.

If the change moves existing URLs, the AI follows up with a **URL migration proposal** — a second, separate approval that previews every moved page and the 301 redirects that will be created. Nothing moves until you click.

## Translating pages

Say *"translate the pricing page into German"*. The AI:

1. creates the German counterpart as a **draft** with a localized slug (`/de/preise`, not `/de/pricing` — URLs are freely localizable because language linkage never depends on matching slugs),
2. translates the **whole page in one pass** — title and every content field together, never sentence-by-sentence — so terminology and tone stay coherent across the page,
3. leaves it in draft for your review; publish when it reads right.

Corrections stick. Tell the chat *"we say Kasse, not Checkout"* and the term lands in the site glossary; *"use informal du on the German site"* becomes the German style guide. Every later translation applies both automatically.

When you edit a source page after its translations exist, the affected translations are marked stale within seconds. Ask *"update the German translations"* and only the changed parts are re-translated — hand-polished wording elsewhere is preserved.

## What visitors and search engines see

- **Published translations only.** A page whose German version is still in draft returns a clean 404 on the German URL — never an automatic fallback to English. That is deliberate, correct SEO behaviour.
- **hreflang + sitemap.** Published language counterparts link each other with `hreflang` alternates (including `x-default` on the default language), and the sitemap carries the same alternates. No configuration.
- **Language selector.** Ask the AI to add a language switcher to your header — it renders as plain HTML links at deploy time, no JavaScript.

## Removing it

Uninstalling the plugin is approval-gated and previews the blast radius: translated pages keep working at their current URLs (URLs are materialized, not computed through the plugin), and the plugin's own data — locale registry, glossary, style guides, variant links — is deleted.
