-- SPDX-License-Identifier: MPL-2.0
--
-- 0119 — bring-your-own-design (issue #199, epic #186).
--
-- source_kind         — where a draft came from: 'genesis' (divergent
--                       AI drafts), 'byod_image' (AI-authored faithful
--                       reproduction of an operator mockup),
--                       'byod_html' (operator-provided HTML,
--                       sanitised at the op boundary).
-- reference_asset_id  — for byod_image: the uploaded mockup itself.
--                       The parity gate compares the materialised page
--                       against THIS image — the operator's asset is
--                       the contract, not the AI's reproduction of it.

BEGIN;

SET LOCAL caelo.actor_kind = 'system';

ALTER TABLE genesis_drafts ADD COLUMN source_kind text NOT NULL DEFAULT 'genesis'
  CHECK (source_kind IN ('genesis', 'byod_image', 'byod_html'));
ALTER TABLE genesis_drafts ADD COLUMN reference_asset_id uuid NULL REFERENCES media_assets(id);

-- site-genesis skill: the BYOD branch (guarded amendment).
UPDATE skills
SET body = body || '

BRING-YOUR-OWN-DESIGN: when the operator already HAS a design, do not run the divergent draft fan-out — their asset is the contract. Two shapes: (a) a mockup image attached in chat — study it, author ONE complete self-contained index.html reproducing it faithfully (same palette, typography, layout; same authoring rules as Genesis drafts), and `save_genesis_draft` with sourceKind: "byod_image" and referenceAssetId set to the attachment''s assetId; (b) provided HTML — save it directly with sourceKind: "byod_html" (scripts are stripped at the boundary; say so if theirs relied on them). Then the NORMAL path continues: operator confirms at /design/genesis, select, materialise — and for byod_image the parity gate compares the built page against their original mockup, not against your reproduction.'
WHERE slug = 'site-genesis'
  AND body NOT LIKE '%BRING-YOUR-OWN-DESIGN%';

COMMIT;
