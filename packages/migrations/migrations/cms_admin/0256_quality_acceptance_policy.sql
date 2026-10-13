-- SPDX-License-Identifier: MPL-2.0
--
-- 0256 — issue #667: the AI no longer pushes quality acceptances.
--
-- Dogfooding on searchviu, the AI fixed what it could, then recommended
-- accepting the remaining Lighthouse findings ("I'd accept all four ... so
-- that 93 becomes the new baseline") and offered to request the approval.
-- Two of them were Caelo bugs (the audit browser disabled the back/forward
-- cache; media shipped with a 1-hour cache lifetime). The
-- `fix-quality-findings` skill told it to propose an acceptance for
-- anything it "cannot or should not fix".
--
-- Step 5 now: findings get_quality_audit marks CAELO PLATFORM are reported
-- with bug_report; everything else that cannot be fixed is described
-- plainly; accept_quality_findings only on the operator's explicit request
-- (the same rule publish_despite_failed_audit already had). Step 3 gains
-- the image-delivery fix the build now honours (an `orig` <img> that
-- declares `sizes` gets the WebP ladder as srcset).
--
-- Targeted `replace()` guarded by `body LIKE` on the exact old sentence, as
-- in 0246: idempotent, a no-op on an install whose text has moved on, and it
-- never touches an Owner-edited body that no longer carries it.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

UPDATE skills
   SET body = replace(
     body,
     '5. WHAT YOU CANNOT OR SHOULD NOT FIX, ASK ABOUT. An intended design choice (a brand colour the editor wants), a third-party embed, or a score the page cannot reach — propose an acceptance with `accept_quality_findings` (page path + audit id or category, one plain-language reason, everything of one decision in ONE call). The editor decides on the card. An acceptance applies only to that page. Check `list_quality_acceptances` first; never ask twice.',
     '5. WHAT YOU CANNOT FIX: DESCRIBE IT, NEVER PUSH IT THROUGH. Accepting a finding lowers the page''s quality bar for good, so it is the operator''s decision, never your recommendation.
   - Findings `get_quality_audit` marks CAELO PLATFORM (back/forward cache, caching of Caelo''s own files, server response, compression, redirects) come from Caelo itself, not from this site. Do not edit the site for them. Report each once with `bug_report` (check `list_bug_reports` first) and tell the operator plainly that it is a Caelo platform issue you reported.
   - An intended design choice (a brand colour the editor wants), a third-party embed, or a score the page cannot reach: describe it in plain words.
   - In both cases say that Publish live stays blocked until it is fixed or the operator decides to accept it. Do not write "I would accept …" and do not offer to request the approval.
   - Use `accept_quality_findings` ONLY when the operator explicitly asks to accept a finding or to publish as it is: page path + audit id or category, their reason, everything of one decision in ONE call. An acceptance applies only to that page. Check `list_quality_acceptances` first; never ask twice.'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%5. WHAT YOU CANNOT OR SHOULD NOT FIX, ASK ABOUT. An intended design choice (a brand colour the editor wants), a third-party embed, or a score the page cannot reach — propose an acceptance with `accept_quality_findings` (page path + audit id or category, one plain-language reason, everything of one decision in ONE call). The editor decides on the card. An acceptance applies only to that page. Check `list_quality_acceptances` first; never ask twice.%';

UPDATE skills
   SET body = replace(
     body,
     '   - `errors-in-console`: a script in a module throws or a resource 404s — fix the module''s JS or the broken URL.',
     '   - `image-delivery-insight` on a library image: give the `<img>` a `sizes` attribute with the width it is displayed at (e.g. `sizes="160px"`, or `sizes="(max-width: 600px) 100vw, 480px"`) plus `width`/`height` — the build then serves the right-sized WebP from the image''s variants instead of the full original.
   - `errors-in-console`: a script in a module throws or a resource 404s — fix the module''s JS or the broken URL.'
   )
 WHERE slug = 'fix-quality-findings'
   AND body LIKE '%   - `errors-in-console`: a script in a module throws or a resource 404s — fix the module''s JS or the broken URL.%'
   AND body NOT LIKE '%image-delivery-insight%';

UPDATE skills
   SET allowlisted_tools = allowlisted_tools || '["bug_report","list_bug_reports"]'::jsonb
 WHERE slug = 'fix-quality-findings'
   AND jsonb_array_length(allowlisted_tools) > 0
   AND NOT allowlisted_tools @> '["list_bug_reports"]'::jsonb;

COMMIT;
