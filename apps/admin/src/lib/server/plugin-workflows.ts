// SPDX-License-Identifier: MPL-2.0

interface VisibleSkill {
  slug: string;
  displayName: string;
}

/** Only live, discoverable companion skills can offer an entry into a plugin workflow. */
export function pluginWorkflowSuggestions(
  skills: readonly VisibleSkill[],
  pluginSkillSlugs: ReadonlySet<string>,
): { label: string; message: string }[] {
  const seen = new Set<string>();
  return skills
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
