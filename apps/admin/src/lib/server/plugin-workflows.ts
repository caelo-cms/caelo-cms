// SPDX-License-Identifier: MPL-2.0

interface VisibleSkill {
  slug: string;
  displayName: string;
  /** ISO timestamp; null for a skill never activated. */
  activatedAt?: string | null;
}

/**
 * Only live, discoverable companion skills can offer an entry into a plugin
 * workflow. At most eight are shown, the most recently activated first —
 * a plugin the Owner just approved must not drop off the list because its
 * slug sorts late.
 */
export function pluginWorkflowSuggestions(
  skills: readonly VisibleSkill[],
  pluginSkillSlugs: ReadonlySet<string>,
): { label: string; message: string }[] {
  const seen = new Set<string>();
  const newestFirst = [...skills].sort((a, b) =>
    (b.activatedAt ?? "").localeCompare(a.activatedAt ?? ""),
  );
  return newestFirst
    .filter((skill) => {
      if (!pluginSkillSlugs.has(skill.slug) || seen.has(skill.displayName)) return false;
      seen.add(skill.displayName);
      return true;
    })
    .slice(0, 8)
    .map((skill) => ({
      label: skill.displayName,
      message: `I'd like to get started with ${skill.displayName}. Please guide me through this workflow and ask about what I want to create.`,
    }));
}
