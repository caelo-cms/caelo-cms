-- SPDX-License-Identifier: MPL-2.0
--
-- v0.2.48 — clear brand-voice-guard's allowlistedTools.
--
-- The seed in 0032_p10a_skills.sql created brand-voice-guard with
-- alwaysOn=true AND allowlistedTools=['site_memory_propose']. The
-- chat-runner narrowed every chat session's tool catalogue to the
-- union of engaged skills' allowlists. When no other skill engaged,
-- the alwaysOn brand-voice-guard was the only contributor — every
-- chat got restricted to a single propose-memory tool, leaving the
-- AI unable to do anything else. Reproduced by an operator chat:
-- "please craft me a website with header etc" where no compose-page
-- keyword fired, brand-voice-guard alone engaged via alwaysOn, and
-- the AI replied with "I only have site_memory_propose, the
-- module-placement tools aren't wired up."
--
-- Two-part fix:
--  1. (this migration) clear the allowlist on the existing row so
--     the AI sees its full catalogue even when only brand-voice-guard
--     is engaged.
--  2. (chat-runner.ts) skip alwaysOn-only engagements when computing
--     the allowlist union. Belt + braces: even if a future skill
--     repeats the mistake, the runner ignores the contribution.
--
-- The body of brand-voice-guard already mentions calling
-- site_memory_propose explicitly when voice changes come up, so the
-- skill's intent is preserved without the allowlist enforcement.

UPDATE skills
   SET allowlisted_tools = '[]'::jsonb
 WHERE slug = 'brand-voice-guard'
   AND allowlisted_tools = '["site_memory_propose"]'::jsonb;
