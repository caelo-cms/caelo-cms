---
slug: quality-gate
template: doc-page
status: published
seo:
  title: Quality gate — Caelo CMS
  description: Every Stage is checked against the optimum — 100 in every Lighthouse category and zero findings. Every finding blocks Publish live until the AI fixes it or an editor accepts it, in bulk if need be.
---

# The quality gate

Caelo checks every Stage before it can go live, with two kinds of checks:

- **Page checks** read every page of the staged build on every Stage — also a Stage that only changed SEO texts. Plugins add them; the SEO checks plugin is the first (in progress).
- **Lighthouse** — Performance, Accessibility, Best Practices and SEO, on a mobile viewport — audits a Stage that can change how pages look or perform. The target is 100 in every category.

The target is the **optimum**: 100 in every Lighthouse category and zero findings. A 90 is not "good enough" — every finding blocks **Publish live** until it is fixed or an editor accepts it. Warnings and hints are shown but never block. The AI keeps fixing until the target is reached wherever it can be; only what truly cannot be fixed comes to you, as one decision per group of findings.

The checks always look at the **staged build** — exactly what Publish live would ship — never at the live site.

## When Lighthouse runs

Lighthouse runs automatically after a Stage that can change how pages look or perform:

- module HTML, CSS or JavaScript was created or changed;
- a layout, template or the theme changed;
- a new page goes live;
- plugin settings that render on pages changed;
- it is the site's first Stage, or the previous check did not end clean.

A Stage that only changes texts and field values, moves existing modules, or edits SEO texts or redirects gets no Lighthouse audit; the page checks still read every page, which takes seconds.

Lighthouse covers the homepage plus the pages the Stage changed (up to five). Performance is the median of three runs; the other categories are measured once.

## Performance metrics

Every page Lighthouse audits also records its Performance metrics — the numbers behind the Performance score:

| Metric | What it measures |
|---|---|
| **FCP** — First Contentful Paint | when the first text or image appears |
| **LCP** — Largest Contentful Paint | when the largest element in view (usually the hero image or heading) appears |
| **TBT** — Total Blocking Time | how long scripts keep the page from responding |
| **CLS** — Cumulative Layout Shift | how much the layout jumps while it loads |
| **SI** — Speed Index | how quickly the visible page fills in |

Each value is the median of the same runs as the Performance score, with Lighthouse's rating (good, needs improvement, poor). With them come the **LCP element** and how its time splits up (server response, load delay, load time, render delay), and the elements that **shifted**, with the cause Lighthouse names (for example an image without a size). If a run could not measure a metric, it is shown as *not measured* with the reason, never as zero.

Metrics are information, not findings: they never block Publish live on their own. The Performance score does that — anything below 100 blocks. They are what the AI fixes against: it reads them, fixes the worst one in the module that renders the named element, Stages again, and repeats until Performance is 100.

The AI reads them in `get_quality_audit` (per audited page) and `check_stage_audit` (the last measured values of the pages your pending changes touch, plus the homepage), so "make the homepage faster" starts from the real staged numbers and the element that causes them. External agents on [Power-MCP](/mcp) get the same two tools and should use them instead of running Lighthouse themselves: the audit runs against the real staged build, which no other URL serves.

Missing meta descriptions do not wait for this check: a Stage (and any production build) refuses published pages without one and names them, because the check only looks at a few pages. See [Live edit](/live-edit).

## What blocks Publish live

Every page is held to the same target, with no exceptions carried over from the past. A Stage is blocked when, on any checked page:

- a Lighthouse category scores **below 100** — 99 blocks as much as 60;
- a Lighthouse audit scores **below a perfect score** (Lighthouse's own report shows audits from 0.9 up in green; Caelo does not);
- a page check reports an error (or, site-wide, an error about the whole site);

and no live acceptance covers it.

Findings caused by the platform block too, including a Performance score they pull down. Caelo does not quietly leave them out: that would also hide real regressions in how sites are served. They are reported as Caelo bugs and fixed in Caelo.

### Accepting, in bulk

What cannot be fixed — a third-party embed, a brand colour you want to keep, a platform issue Caelo has not fixed yet — an editor can **accept**. Acceptances work per group: one rule across all the pages it fails on, for example *"seo-check/description-missing: 312 pages"* or *"lighthouse/performance/unused-javascript: 14 pages"*. One decision covers the whole group, or the pages you pick from it.

An acceptance records the **value measured** when it was made: the category score, the audit's score, or the number of page-check errors. It covers that value, and blocks again when the page gets worse. When the page gets better, the acceptance tightens to the better value; once the page reaches the target, the acceptance is used up. Acceptances apply only to their pages — the same finding on another page still blocks.

### Measurement noise

Lighthouse's Performance score jitters a little between runs of the same page. Caelo handles that in two places and nowhere else:

- The Performance score is the **median of three runs**, and an audit that only Performance uses counts when it fails in most of those runs.
- When a Performance value is compared with an **accepted** value, it may be up to **2 points** below it before it counts as worse. This tolerance never applies against the target: without an acceptance, a Performance of 99 blocks. Accepted Performance values are also never tightened or used up automatically — a lucky run would otherwise raise the bar to noise — so they stay until an editor revokes them.

Accessibility, Best Practices, SEO and the page checks are deterministic: no tolerance at all.

## How it plays out in the chat

1. You Stage — or the AI stages its finished work. A minute or two later the result appears in the same chat.
2. If there are problems, the chat **asks you first**, with the findings **grouped by rule across pages**: *"Quality check found 2 kinds of issue on 312 pages: Missing meta description (312 pages); Performance score below 100 (3 pages)."* Nothing changes until you decide. This holds however the Stage happened — your **Stage** button, **Open changes**, the AI's own Stage, or an external agent's. You may have moved on while the check ran, and the AI may not have made every staged change.
   - **Fix all with AI** starts the fix of everything. The AI gets the findings by group, who staged the build, and a reminder that the build can contain changes from other chats or agents, so it checks the page before changing it. It is told the target is 100 and zero findings, fixes what it can — missing alt texts, low contrast, missing labels and headings, meta descriptions, image sizes, render-blocking CSS, layout shifts — and Stages again, which re-checks.
   - Per group you choose: **Fix all** (the AI fixes only that group), **Accept all…** (you accept the group on every page with a reason — it counts at once, Publish live opens as soon as nothing else blocks), or **Pick pages** (tick pages, then fix or accept just those).
   - **Not now** leaves the site as it is. The chat notes your decision, and Publish live stays blocked until the problems are fixed or accepted.
   - Or just type what you want instead ("only fix the homepage", "leave the contrast").
3. Every fix round is started by you. After two rounds the card says the findings are left after those rounds and offers **Keep fixing with AI** together with the same per-group choices.
4. When the AI finds something it truly cannot fix, it says **why** and offers you one decision per group — an approval card in the chat. It does not call a score below 100 good enough, does not offer an acceptance for something it could still fix, and does not recommend accepting. You approve or reject the card.
5. Some findings are caused by Caelo itself, not by your site: back/forward cache, cache lifetimes of Caelo's own files, server response time, compression, redirects. The AI does not change your site for them. It reports each one as a Caelo bug and tells you so. Publish live stays blocked until the platform is fixed, or until you decide to accept the finding.

The toolbar always says why Publish live is blocked and offers the next step: *Retry check*, *Stage again*, or *Publish anyway* (see below).

## When the check itself fails

If the check cannot produce a result — the browser crashed, a timeout, staging was unreachable — it never silently passes. Publish live stays blocked and the chat says *Audit failed* with a **Retry check** button. If you need to publish without a result, an editor who may publish can choose **Publish anyway** with a reason. That decision is recorded with their name and reason and listed in the quality view. The AI can only propose it; a human decides.

## Production builds and the automatic redeploy

A direct production build (*Build production* on the Deployments page) builds the site as it is now, so it obeys the same gate. It runs when the gate of the last Stage is open and the site still looks the way that check saw it. If module code, a template, a layout, the theme or a plugin changed since, or a page went live since, it is refused with *Stage again* so the change is checked first. Text, SEO and other content edits don't count. When the check itself failed, the build needs a recorded *publish anyway*. The reason is saved only once the build succeeded.

The automatic redeploy (Settings → Gateway) works the same way. When only content changed since the last checked Stage, it rebuilds production directly. Otherwise it Stages, checks the pages the changes appear on, and publishes that exact build automatically only when the check is clean (or every problem was accepted). If the check finds problems, fails, is interrupted, or a newer Stage replaces it, the redeploy stops, and the Deployments page and the notification bell show why — like a failed manual Publish.

## The quality view

**Settings → Quality** (`/settings/quality`) shows:

- the gate of the current staged build and why it is open or blocked;
- recent checks with their findings per page, including page-check warnings and site-wide findings;
- per page Lighthouse audited, its Performance metrics (FCP, LCP, TBT, CLS, Speed Index) with the LCP element and the layout shifts;
- every accepted finding, **grouped per decision** (one rule across its pages) with the value accepted per page and the reason. A site-wide acceptance (an error about the whole site, not a page) is its own group, marked *site-wide*. The Owner can **revoke** a whole group, a selection, or a single page in one go; what was revoked blocks again at once, without a new check. Revoked and used-up acceptances stay listed as history;
- every *publish anyway* decision with who made it and why.

## Upgrading from the earlier rules

Before this version, the gate let existing debt pass: audits scoring 0.9 or more were not findings, and each page kept a **baseline** per category — a score could only block when it fell below that page's previous score. The upgrade ends both, without carrying anything over:

- **Existing debt blocks after the upgrade.** Scores below 100, audits between 0.9 and 1, and everything a baseline below 100 let pass show up as blocking findings on the next check.
- **Baselines are not turned into acceptances.** A baseline was the gate's memory, never an editor's decision. Existing acceptances stay; accepted findings get the score measured when they were accepted, so a worse score blocks again.
- **The staged build is checked again.** Its last check ran under the earlier rules, so Publish live asks for a new check first (*Retry check* in the toolbar, or Stage again). Expect a longer list of findings than before: let the AI fix them, and accept in bulk what cannot be fixed.

## Server sizing

The check runs on the admin server itself, using the Chromium build that ships in the admin image. Lighthouse runs in a separate process that gets no database credentials or secrets. Every provider exposes the same `adminMemory` setting, defaulting to `2Gi`, and [`upgrade`](/install-gcp#upgrading) raises existing GCP installs to it. It never lowers a larger value.

| Provider | Setting |
|---|---|
| GCP / GCP + Firebase | `pulumi config set caelo-gcp:adminMemory 2Gi` (Cloud Run memory; billed only while an instance runs) |
| Azure | `caelo-azure:adminMemory` (CPU follows at 2 GiB per vCPU) |
| AWS | `caelo-aws:adminMemory` |
| Self-hosted | `caelo-self-hosted:adminMemory` (reserved for the admin container) |

On providers whose staging has no public URL (GCP behind IAP, AWS, Azure), the admin serves the staged build to the check over a short-lived loopback port. This port is read-only and closes when the check ends.
