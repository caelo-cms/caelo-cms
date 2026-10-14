-- SPDX-License-Identifier: MPL-2.0
--
-- 0277 — issue #727, "optimum, not good enough": the fix-quality-findings
-- playbook learns the new target.
--
-- An AI agent once called a Lighthouse Performance score of 90 "fine"; sent
-- back, it fixed the layout shifts and reached 100. The playbook now says
-- the target is 100 in every category and zero findings, that a 90 is not
-- acceptable on its own, that a Performance fix iterates on the metrics
-- get_quality_audit reports (never a self-run Lighthouse), and that what
-- truly cannot be fixed goes to the operator as ONE decision per group of
-- findings (accept_quality_findings with `groups`, migration 0276's bulk
-- acceptance) — explained, never recommended. The baseline wording goes
-- (0276 retired the per-page baselines), and so does the "at most two
-- automatic fix rounds" stop: every round is the operator's click (#685).
--
-- Targeted replace() guarded by `body LIKE` on the exact old text (as 0256,
-- 0273, 0274): idempotent, and an Owner-edited body that no longer carries
-- a sentence keeps its own wording for that sentence.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     'You are fixing problems the QUALITY CHECK found on the staged build. Publish live stays blocked until every problem is fixed or an editor accepted it on its page.',
     'You are fixing problems the QUALITY CHECK found on the staged build. Publish live stays blocked until every problem is fixed or an editor accepted it on its page.

0. THE TARGET IS THE OPTIMUM: 100 in every Lighthouse category (Performance, Accessibility, Best Practices, SEO) and zero findings. A score like 90 is NOT acceptable on its own and is never "good enough" — every category below 100 and every audit below a perfect score is a problem. Keep fixing until the target is reached wherever it is achievable; an earlier run took Performance from 90 to 100 by fixing layout shifts (CLS) once it was sent back.'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%You are fixing problems the QUALITY CHECK found on the staged build. Publish live stays blocked until every problem is fixed or an editor accepted it on its page.%';

UPDATE skills
   SET body = replace(
     body,
     'a category score below the page''s baseline, or a page-check rule id',
     'a category score below 100, or a page-check rule id'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%a category score below the page''s baseline, or a page-check rule id%';

UPDATE skills
   SET body = replace(
     body,
     'For a Performance score below its baseline, read the page''s metrics in `get_quality_audit` first',
     'For a Performance score below 100, read the page''s metrics in `get_quality_audit` first'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%For a Performance score below its baseline, read the page''s metrics in `get\_quality\_audit` first%';

UPDATE skills
   SET body = replace(
     body,
     'and fix the worst one in the module that renders that element. Never run Lighthouse yourself: the audit already ran against the real staged build.',
     'and fix the worst one in the module that renders that element; after the next Stage read them again and fix the next one, until Performance is 100. Never run Lighthouse yourself: the audit already ran against the real staged build.'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%and fix the worst one in the module that renders that element. Never run Lighthouse yourself: the audit already ran against the real staged build.%';

UPDATE skills
   SET body = replace(
     body,
     'You have at most TWO automatic fix rounds; after that, stop changing the site for these findings.',
     'Every fix round starts with the operator''s click on the chat''s quality card. Within a round, fix EVERYTHING you can — do not stop at "mostly fixed".'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%You have at most TWO automatic fix rounds; after that, stop changing the site for these findings.%';

UPDATE skills
   SET body = replace(
     body,
     '5. WHAT YOU CANNOT FIX: DESCRIBE IT, NEVER PUSH IT THROUGH. Accepting a finding lowers the page''s quality bar for good, so it is the operator''s decision, never your recommendation.
   - Findings `get_quality_audit` marks CAELO PLATFORM (back/forward cache, caching of Caelo''s own files, server response, compression, redirects) come from Caelo itself, not from this site. Do not edit the site for them. Report each once with `bug_report` (check `list_bug_reports` first) and tell the operator plainly that it is a Caelo platform issue you reported.
   - An intended design choice (a brand colour the editor wants), a third-party embed, or a score the page cannot reach: describe it in plain words.
   - In both cases say that Publish live stays blocked until it is fixed or the operator decides to accept it. Do not write "I would accept …" and do not offer to request the approval.
   - Use `accept_quality_findings` ONLY when the operator explicitly asks to accept a finding or to publish as it is: page path + audit id or category, their reason, everything of one decision in ONE call. An acceptance applies only to that page. Check `list_quality_acceptances` first; never ask twice.',
     '5. WHAT YOU TRULY CANNOT FIX: EXPLAIN WHY AND HAND THE OPERATOR ONE DECISION PER GROUP. "Close enough" is never your call. Before you call something unfixable, read its metrics and flagged elements in `get_quality_audit` again and try the fix.
   - Findings `get_quality_audit` marks CAELO PLATFORM (back/forward cache, caching of Caelo''s own files, server response, compression, redirects) come from Caelo itself, not from this site. Do not edit the site for them. Report each once with `bug_report` (check `list_bug_reports` first) and tell the operator plainly that it is a Caelo platform issue you reported.
   - What truly cannot be fixed (a third-party embed you cannot change, a brand colour the operator confirmed, a Caelo platform issue you reported, a score the page cannot reach for a reason you can name): explain WHY in plain words, then offer the operator ONE decision per group of findings with `accept_quality_findings` using `groups` — e.g. `{ "ruleId": "seo-check/description-missing" }` covers every page that rule is open on, `pagePaths` narrows it, a Lighthouse audit goes by `auditId`, a category below 100 by `category`. All groups of one decision in ONE call. The operator approves or rejects it on the card (their quality card also offers fix all / accept all / pick pages per group).
   - Never offer an acceptance for something you could still fix, never phrase it as your recommendation ("I would accept …"), and never say it is accepted before the operator approved it. Until then Publish live stays blocked.
   - An acceptance records the value measured now (score, audit score, error count); a worse value blocks again. It applies only to its pages. Check `list_quality_acceptances` first; never ask twice.'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%5. WHAT YOU CANNOT FIX: DESCRIBE IT, NEVER PUSH IT THROUGH. Accepting a finding lowers the page''s quality bar for good, so it is the operator''s decision, never your recommendation.
   - Findings `get\_quality\_audit` marks CAELO PLATFORM (back/forward cache, caching of Caelo''s own files, server response, compression, redirects) come from Caelo itself, not from this site. Do not edit the site for them. Report each once with `bug\_report` (check `list\_bug\_reports` first) and tell the operator plainly that it is a Caelo platform issue you reported.
   - An intended design choice (a brand colour the editor wants), a third-party embed, or a score the page cannot reach: describe it in plain words.
   - In both cases say that Publish live stays blocked until it is fixed or the operator decides to accept it. Do not write "I would accept …" and do not offer to request the approval.
   - Use `accept\_quality\_findings` ONLY when the operator explicitly asks to accept a finding or to publish as it is: page path + audit id or category, their reason, everything of one decision in ONE call. An acceptance applies only to that page. Check `list\_quality\_acceptances` first; never ask twice.%';

UPDATE skills
   SET description = 'How to fix what the quality check of the staged build found (Lighthouse: Performance, Accessibility, Best Practices, SEO — target 100 each; page checks — target zero findings) so Publish live opens again, and how to hand the operator a decision on what truly cannot be fixed. Engaged when a quality check reports problems or the operator asks about quality, Lighthouse, PageSpeed, accessibility or a blocked Publish.'
 WHERE slug = 'fix-quality-findings'
   AND description = 'How to fix what the Lighthouse quality check of the staged build found (Accessibility, Best Practices, SEO, Performance) so Publish live opens again. Engaged when a quality check reports problems or the operator asks about quality, Lighthouse, accessibility or a blocked Publish.';

COMMIT;
