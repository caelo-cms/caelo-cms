---
slug: quality-gate
template: doc-page
status: published
seo:
  title: Quality gate — Caelo CMS
  description: Every substantial Stage is checked with Lighthouse. New accessibility, SEO, best-practice or performance problems block Publish live until the AI fixes them or an editor accepts them.
---

# The quality gate

Caelo checks every substantial Stage with **Lighthouse** — Performance, Accessibility, Best Practices and SEO, on a mobile viewport — before it can go live. New problems block **Publish live**. The AI fixes what it can; what it can't fix, an editor decides about. The target is 100 in every category.

## When a Stage is checked

The check runs automatically after a Stage that can change how pages look or perform:

- module HTML, CSS or JavaScript was created or changed;
- a layout, template or the theme changed;
- a new page goes live;
- plugin settings that render on pages changed;
- it is the site's first Stage, or the previous check did not end clean.

A Stage that only changes texts and field values, moves existing modules, or edits SEO texts or redirects is not checked — it goes live as before.

The check covers the homepage plus the pages the Stage changed (up to five). Performance is the median of three runs; the other categories are measured once.

## What blocks Publish live

Each page keeps a **baseline** per category, starting at 100. A Stage is blocked when:

- a Lighthouse audit fails that nobody accepted on that page, or
- a category score falls below the page's baseline. Performance jitters, so a performance drop only counts when two consecutive checks show it.

When a page scores higher, its baseline rises with it — quality only ratchets up.

## How it plays out in the chat

1. You Stage. A minute or two later the result appears in the same chat.
2. If there are problems, the AI reads the findings and fixes what it can — missing alt texts, low contrast, missing labels and headings, meta descriptions, image sizes, render-blocking CSS. Then it asks you to **Stage again**, which re-checks.
3. The AI gets at most **two automatic fix rounds**. After that it stops changing the site and asks you about what is left.
4. Anything intended — a brand colour, a third-party embed — the AI asks you to **accept** on a card in the chat: "Accept this finding on /pricing?" with a reason. Any editor may accept. An acceptance applies to **that page only**; the same finding on another page still blocks. An accepted score becomes that page's new baseline.

The toolbar always says why Publish live is blocked and offers the next step: *Retry check*, *Stage again*, or *Publish anyway* (see below).

## When the check itself fails

If the check cannot produce a result — the browser crashed, a timeout, staging was unreachable — it never silently passes. Publish live stays blocked and the chat says *Audit failed* with a **Retry check** button. If you need to publish without a result, an editor who may publish can choose **Publish anyway** with a reason. That decision is recorded with their name and reason and listed in the quality view. The AI can only propose it; a human decides.

## Production builds and the automatic redeploy

A direct production build (*Build production* on the Deployments page) builds the site as it is now, so it obeys the same gate. It runs when the gate of the last Stage is open and the site still looks the way that check saw it. If module code, a template, a layout, the theme or a plugin changed since, or a page went live since, it is refused with *Stage again* so the change is checked first. Text, SEO and other content edits don't count. When the check itself failed, the build needs a recorded *publish anyway*. The reason is saved only once the build succeeded.

The automatic redeploy (Security → Gateway) works the same way. When only content changed since the last checked Stage, it rebuilds production directly. Otherwise it Stages, checks the pages the changes appear on, and publishes that exact build automatically only when the check is clean (or every problem was accepted). If the check finds problems, fails, is interrupted, or a newer Stage replaces it, the redeploy stops, and the Deployments page and the notification bell show why — like a failed manual Publish.

## The quality view

**Security → Quality** (`/security/quality`) shows:

- the gate of the current staged build and why it is open or blocked;
- recent checks with their findings per page;
- every accepted finding — the Owner can **revoke** one, after which it blocks again on its page;
- baselines below 100;
- every *publish anyway* decision with who made it and why.

## Server sizing

The check runs on the admin server itself, using the Chromium build that ships in the admin image. Lighthouse runs in a separate process that gets no database credentials or secrets. Every provider exposes the same `adminMemory` setting, defaulting to `2Gi`, and `bunx @caelo-cms/provisioning upgrade` raises existing GCP installs to it. It never lowers a larger value.

| Provider | Setting |
|---|---|
| GCP / GCP + Firebase | `pulumi config set caelo-gcp:adminMemory 2Gi` (Cloud Run memory; billed only while an instance runs) |
| Azure | `caelo-azure:adminMemory` (CPU follows at 2 GiB per vCPU) |
| AWS | `caelo-aws:adminMemory` |
| Self-hosted | `caelo-self-hosted:adminMemory` (reserved for the admin container) |

On providers whose staging has no public URL (GCP behind IAP, AWS, Azure), the admin serves the staged build to the check over a short-lived loopback port. This port is read-only and closes when the check ends.
