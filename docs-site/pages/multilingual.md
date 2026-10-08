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
- **Default language.** Exactly one locale is the default; its pages keep their bare URLs — unless you prefix it too (below).

### Prefixing the default language too

Some sites want every language to carry its prefix — `/de/preise` next to `/en/pricing` — instead of a bare default. Say *"put the German pages under /de/ as well"* and the AI turns on **`prefixDefaultLocale`** in the same approval-gated locale change (the `set_locales` tool; it needs the default language on the `subdirectory` strategy). With it on:

| | Default language (`de`) | Other languages (`en`) |
|---|---|---|
| Home page | `/` — served directly, no redirect | `/en/` |
| Other pages | `/de/<slug>/` | `/en/<slug>/` |
| `/de/` | 301 to `/` | — |

The default home stays at `/` so visitors and crawlers reaching the bare domain get the page on the first request instead of a redirect hop; `/de/` 301s to it so the home has a single canonical address. Canonicals, sitemap entries, hreflang (the home's `de` and `x-default` alternates both point at `/`), the language switcher and the page list in the admin all follow, because they read the same composed page address.

Turning it on (or off) moves every default-language page except the home. As with any URL change, the AI follows up with a **URL migration proposal** that previews the moves and creates a 301 from each old address — nothing moves until you approve it. Links you wrote by hand in page content or menus keep their old address and reach the page through that 301; ask the AI to update them afterwards. The setting is off by default, and leaving it out of a later locale change keeps its current value.

If the change moves existing URLs, the AI follows up with a **URL migration proposal** — a second, separate approval that previews every moved page and the 301 redirects that will be created. Nothing moves until you click.

## Translating pages

Say *"translate the pricing page into German"*. The AI:

1. creates the German counterpart as a **draft** with a localized slug (`/de/preise`, not `/de/pricing` — URLs are freely localizable because language linkage never depends on matching slugs),
2. translates the **whole page in one pass** — title and every content field together, never sentence-by-sentence — so terminology and tone stay coherent across the page,
3. leaves it in draft for your review; publish when it reads right.

Corrections stick. Tell the chat *"we say Kasse, not Checkout"* and the term lands in the site glossary; *"use informal du on the German site"* becomes the German style guide. Every later translation applies both automatically.

When you edit a source page after its translations exist, the affected translations are marked stale within seconds. Ask *"update the German translations"* and only the changed parts are re-translated — hand-polished wording elsewhere is preserved.

## Menus, header and footer per language

Your navigation, header, footer and any content shared across pages exist once per language. Say *"translate the site chrome into German"* (or *"update the German translations"*, which includes it), and the AI translates all of it in one pass, so the menu and the footer use the same terms. German pages then show the German menus and footer, and English pages show the English ones.

- **Links follow the language.** A menu link to *About* on a German page goes to the German *About* page automatically. If that page has no German version yet, or it is not published, the preview flags the link and publishing stops until you fix it.
- **Nothing falls back silently.** If a German page would show chrome that has no German version yet, the preview flags it and publishing stops with a message naming what is missing. Pages never quietly show the English footer.
- **A language can have its own chrome.** By default a language's menus are translations of the default language's: when you edit the English menu, the German one is marked for re-translation. Say *"the German menu should not have the Careers link"* or *"use the other footer on the German site"*, and the AI detaches that language's version. It then keeps its own items, links and even a different footer or menu module, and English edits no longer touch it. Switching it back to the translated version replaces its own content, so the AI asks you to approve that in the chat first.

## What visitors and search engines see

- **Published translations only.** A page whose German version is still in draft returns a clean 404 on the German URL — never an automatic fallback to English. That is deliberate, correct SEO behaviour.
- **Document language.** Every page carries its language as `<html lang>` — screen readers pronounce the text correctly and search engines classify the page. A German page is announced as `de`, every other page as the site language. The site language has no default: the AI sets it from the language you write in (or from your old site when you migrate), you can say *"our site is in German"* to change it, or set it at **Security → SEO**. Until it is set, the preview flags it and publishing stops with a message saying so. The same applies to single-language sites without the plugin.
- **hreflang + sitemap.** Published language counterparts link each other with `hreflang` alternates (including `x-default` on the default language), and the sitemap carries the same alternates. Every alternate and every language-switcher link is exactly the target page's canonical URL — same host, same trailing slash as your hosting serves — so search engines never see a redirect between alternates. No configuration.
- **Language selector.** Ask the AI to add a language switcher to your header — it renders as plain HTML links at deploy time, no JavaScript.

## Removing it

Uninstalling the plugin is approval-gated and previews the blast radius: translated pages keep working at their current URLs (URLs are materialized, not computed through the plugin), and the plugin's own data — locale registry, glossary, style guides, variant links — is deleted.
