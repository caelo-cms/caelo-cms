-- SPDX-License-Identifier: MPL-2.0
--
-- 0176 — site-migrate: ask the DESIGN DIRECTION up front.
--
-- The #278 flow crawled + built the homepage and only THEN asked "passt die
-- Richtung?" (a 2-way confirm), silently defaulting to "improve/refresh". That
-- mismatched the welcome copy ("we keep or refresh its design") and surprised
-- operators, who expect to choose the design intent before the AI charges into
-- a crawl. This adds an explicit 3-way choice — 1:1 keep / refresh / optimized
-- proposal — right after the site-understand read-back and BEFORE the crawl
-- proposal, and threads that choice through THE REBUILD CONTRACT. The homepage
-- confirmation (step 3) stays as the RESULT check. Surgical replace(), idempotent.

BEGIN;

UPDATE skills
SET body =
  replace(
  replace(
  replace(
  replace(
  replace(body,
    -- A) step 0 no longer forbids the up-front design question.
    $a$Do NOT preview the later decisions; the design direction is confirmed later, on the finished homepage, as a clickable choice.$a$,
    $a$Don't pile other questions on here; the design-direction choice comes right after you have glanced the site (step 1), and the finished homepage confirms it again (step 3).$a$
  ),
    -- B) new DESIGN DIRECTION sub-step at the end of step 1 (before the crawl).
    $b$the important types are yours to pick (see step 5).$b$,
    $b$the important types are yours to pick (see step 5).
   - DESIGN DIRECTION — NOW, before proposing the crawl, ask the ONE design question via `offer_choices`, framed on what you just saw ("So baue ich das Design deiner Seite auf — wie hättest du es am liebsten?"): A) 1:1 BEIBEHALTEN — so nah wie möglich am Original, nur sauber nachgebaut; B) AUFFRISCHEN — gleiche Marke, Struktur und Inhalte, aber modernisiert (der Standard, wenn du dir unsicher bist); C) OPTIMIERTER VORSCHLAG — ich schlage eine deutlich verbesserte Richtung vor. WAIT for the answer — it sets the improve-vs-preserve stance for the WHOLE run (see FOLLOW THE CHOSEN DIRECTION in THE REBUILD CONTRACT). This is the design INTENT, asked once; step 3 later confirms the RESULT on the built homepage. Do NOT crawl or build before the operator picks.$b$
  ),
    -- C) step 3 becomes a RESULT confirmation of the chosen direction.
    $c$showing the homepage first: "So sieht deine Startseite aus — passt die Richtung?", options A) Passt, so weiter, B) Ändere noch etwas (take their note and adjust, then re-check).$c$,
    $c$showing the homepage first: "So sieht deine Startseite im gewählten Stil aus — passt die Richtung?", options A) Passt, so weiter, B) Ändere noch etwas (take their note and adjust, then re-check). This confirms the RESULT of the direction the operator PICKED in step 1, now on a real rendered page.$c$
  ),
    -- D) improve-vs-preserve now keys off the step-1 choice, not a silent default.
    $d$IMPROVE BY DEFAULT: fix broken tables, ugly bullet lists, awkward spacing, dated patterns while you rebuild. The result must read better than the source. Preserve the exact original look ONLY when the operator explicitly asked for 1:1.$d$,
    $d$FOLLOW THE CHOSEN DIRECTION (the design choice from step 1): 1:1 BEIBEHALTEN → preserve the original look as closely as the rebuild allows, fixing only what is genuinely broken; AUFFRISCHEN (the default) → keep the brand, structure and content but modernise — fix broken tables, ugly bullet lists, awkward spacing, dated patterns; OPTIMIERTER VORSCHLAG → go further and propose a clearly better layout and hierarchy. In every case the result must read at least as well as the source and never lose content.$d$
  ),
    -- E) the up-front choice is now a third operator stop.
    $e$the design-direction check (step 3) and the FINISH confirmation (step 6) are the ONLY two moments you stop for the operator.$e$,
    $e$the design-direction choice (step 1), the homepage confirmation (step 3), and the FINISH confirmation (step 6) are the ONLY moments you stop for the operator.$e$
  )
WHERE slug = 'site-migrate';

COMMIT;
