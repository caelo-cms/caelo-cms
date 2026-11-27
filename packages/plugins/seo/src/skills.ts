// SPDX-License-Identifier: MPL-2.0

/**
 * The seo plugin's companion skills (the `companion_skills` grant). They go
 * live and archive with the plugin (CLAUDE.md §2): the `## Skills` index is
 * the only surface that tells the AI what the plugin can do.
 *
 * Written in the operator's terms (CLAUDE.md §1A): the operator says "the
 * blog should show who wrote each article"; the AI decides the page types,
 * modules, mapping and checks. Bodies stay short; the rules that prevent a
 * failed call live in the tool texts, not here.
 */

import type { PluginSkillSpec } from "@caelo-cms/plugin-sdk";
import { CRAWLER_POLICY_SKILL, SEO_AUDIT_SKILL } from "./skills-checks.js";

/** Every skill the plugin ships. */
export const SEO_SKILLS: readonly PluginSkillSpec[] = [SEO_AUDIT_SKILL, CRAWLER_POLICY_SKILL];
