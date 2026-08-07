# Consent and tracking management

The `consent-manager` plugin gives a Caelo site a GDPR consent dialog, a
place to register tracking tags, and automatic handling of modules that
load something from a third party.

It is a plugin. Activate it at `/security/plugins` and it exists;
deactivate it and nothing of it runs.

---

## The one thing to understand first

**The plugin owns behaviour. The AI owns everything you can see.**

Recording a visitor's choice, keeping a tag from firing before it, and
holding an embed until the visitor agrees are the parts a regulator asks
about. Those cannot depend on AI-authored module JavaScript being right
this time, so the plugin ships them itself.

Everything visible — the banner's markup, its copy, its layout, its
colours — is authored by the AI as an ordinary module. A dialog carrying
a plugin's fixed HTML is why every consent banner on the web looks the
same and none of them look like the site behind them.

The two halves meet at documented attributes:

| Attribute | What the runtime does with it |
|---|---|
| `data-consent-banner` | The dialog root. Shown only when a choice is missing or out of date. |
| `data-consent-category="<key>"` | A checkbox for one category. Required ones are ticked and disabled. |
| `data-consent-accept-all` | Grants everything. |
| `data-consent-reject-all` | Grants only what is required. |
| `data-consent-save` | Grants exactly what is ticked. |
| `data-consent-open` | Re-opens the dialog later — put one in the footer. |

A missing or misspelled attribute is reported to the browser console
naming what was expected. A banner that silently does nothing is the
worst outcome available: the site looks compliant and records nothing.

---

## Setting it up

Ask for it. "We need a cookie banner that matches the site" is enough.

The AI reads the contract through `consent_status`, authors one module
that iterates the categories, and places it in the **site layout** —
one placement covers every page, including the next page you add.

The banner iterates rather than hard-codes:

```html
<div data-consent-banner>
  {{#consent_categories}}
    <label>
      <input type="checkbox" data-consent-category="{{key}}">
      {{label}} <span>{{description}}</span>
    </label>
  {{/consent_categories}}
  <button data-consent-accept-all>Accept all</button>
  <button data-consent-reject-all>Reject all</button>
  <button data-consent-save>Save choice</button>
</div>
```

Ask for different wording, another language or a different tone and the
AI rewrites the category copy — it does not fork the text into the
module, or the two drift.

---

## Categories

Four, matching the division regulators and visitors both recognise:

| Key | Meaning |
|---|---|
| `necessary` | The site cannot work without it. Always on; the visitor is told, not asked. |
| `functional` | Remembers preferences. |
| `analytics` | Measures usage, in aggregate. |
| `marketing` | Advertising, and content embedded from other services. |

The **keys are fixed**; only their operator-facing copy is editable.
Tags and withheld modules refer to the keys, so a rename would orphan
every reference to them.

---

## Tracking tags

Register a tag ("add Google Analytics") and it is pinned to a category.
It is injected by the runtime only after the visitor grants that
category — nothing is written into the page, because a tag in the page's
HTML has already run by the time anything could check consent.

Adding one **pauses for your approval**. The test is whether a mistake
can be undone with one click: deleting the tag, yes; the data already
sent to the vendor, no. Removing a tag is not gated — it only ever
reduces what the site loads.

Google Analytics, Google Tag Manager, the Meta pixel, Matomo and Hotjar
carry their own category and script URL, so you do not look either up.

A tag in `necessary` runs for everyone, unasked. Claiming that category
requires a written justification and is rejected without one. If it
measures or follows visitors, it belongs in analytics or marketing.

---

## Embeds from other services

A module that embeds a YouTube player or a Google Map contacts that
company the moment the page renders. The plugin scans every module —
its markup, its stylesheet, its script, its field defaults and the
content bound to it, because the address usually lives in the content
rather than the markup — and withholds the ones that reach out.

A withheld module renders a **placeholder** instead. The real markup is
still in the page, parked inside an inert `<template>`: browsers fetch
nothing inside one, so the vendor is genuinely not contacted. When the
visitor grants the matching category, the runtime swaps the real content
in.

**A vendor nobody has ruled on is withheld too.** Unrecognised is not
the same as harmless, and the asymmetry is one-sided: over-restricting
costs a placeholder, under-restricting sends an unasked request to a
third party. Ask the AI what is waiting on a decision and it will tell
you what each module reaches for.

The placeholder is an ordinary module. Restyle it like any other
content; it needs a `data-consent-accept-all` or `data-consent-open`
control, or it is a dead end.

A YouTube embed can often be switched to `youtube-nocookie.com`, which
is a functional embed rather than a marketing one — worth asking for
before accepting the placeholder.

---

## Proving consent

Ask for the consent record and you get a CSV: when, which visitor, which
categories, which policy version. That is what a data-protection
authority or a DPO asks for.

Records are pruned once past the retention window (a year by default),
because keeping consent evidence forever is itself a data-protection
problem.

**Export before uninstalling.** Deactivating the plugin only stops it
running; uninstalling drops its schema and takes the records with it,
and there is no recovery path afterwards.

---

## When something changes

If what the site does with data actually changes — a new vendor, a new
purpose — ask to re-ask everyone. That invalidates every stored consent
and puts the banner back in front of every visitor.

Do not do it for a wording change. Re-asking for a reworded sentence
trains people to click Accept without reading, which costs you the thing
the banner exists to obtain.
