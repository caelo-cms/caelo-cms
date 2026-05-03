-- SPDX-License-Identifier: MPL-2.0
--
-- P16 revision — drop the duplicate ai_provider_configs table introduced
-- in 0048. The legacy ai_providers table (from 0011_p5_ai_chat) is the
-- production-truth one; new provider config (model, base_url, image_model,
-- is_primary) lives inside its existing `config` jsonb column. Avoids
-- a two-table-of-truth split that would force every reader to know which
-- one is authoritative.

DROP TABLE IF EXISTS ai_provider_configs;
