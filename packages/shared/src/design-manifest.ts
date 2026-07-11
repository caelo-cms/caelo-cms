// SPDX-License-Identifier: MPL-2.0

/**
 * issue #165 — the Design Manifest: a generated, versioned description
 * of THIS site's design system (epic #149, growth-time convergence).
 *
 * The operator requirement is asymmetric: pages of the SAME site share
 * one visual line, while different sites are free to look nothing
 * alike. A global stylesheet solves the first at the cost of the
 * second; the per-site manifest solves both — it captures what this
 * site's tokens/patterns MEAN so the AI converges toward its own
 * design, not a Caelo default.
 *
 * Written at Genesis materialisation (or curated later via chat);
 * rendered as the `## Design system` system-prompt block.
 */

import { z } from "zod";

export const designManifestPattern = z
  .object({
    /** Pattern name the AI reasons in ("hero", "card grid", "cta band"). */
    name: z.string().min(1).max(80),
    /** Stable module `type` implementing it — reuse target (#159 place mode). */
    moduleType: z.string().max(64).optional(),
    /** One-line spec: what makes this pattern THIS site's version of it. */
    spec: z.string().min(1).max(500),
  })
  .strict();

export const designManifestSchema = z
  .object({
    /** `--color-primary` → "CTAs and links only" — usage semantics per var. */
    tokenRoles: z.record(z.string().min(3).max(64), z.string().min(1).max(300)).optional(),
    /** Scale ratio, casing, measure rules. */
    typography: z.string().min(1).max(1000).optional(),
    /** Section padding, container width, grid gaps. */
    rhythm: z.string().min(1).max(1000).optional(),
    patterns: z.array(designManifestPattern).max(24).optional(),
    imagery: z.string().min(1).max(500).optional(),
    avoid: z.string().min(1).max(500).optional(),
  })
  .strict();
export type DesignManifest = z.infer<typeof designManifestSchema>;

/** Render the `## Design system` prompt block. Null when empty. */
export function formatDesignSystemBlock(manifest: DesignManifest | null): string | null {
  if (manifest === null) return null;
  const lines: string[] = [
    "## Design system",
    "",
    "THIS site's own design language — derived from the chosen design. Every module you author or restyle conforms to it unless the operator explicitly asks to break the line. Reuse the pattern's module type (place mode) before minting lookalikes.",
    "",
  ];
  let hasContent = false;
  const roles = manifest.tokenRoles ?? {};
  const roleEntries = Object.entries(roles);
  if (roleEntries.length > 0) {
    hasContent = true;
    lines.push("Token roles:");
    for (const [token, role] of roleEntries.slice(0, 24)) lines.push(`- \`${token}\` — ${role}`);
    lines.push("");
  }
  if (manifest.typography) {
    hasContent = true;
    lines.push(`Typography: ${manifest.typography}`, "");
  }
  if (manifest.rhythm) {
    hasContent = true;
    lines.push(`Rhythm: ${manifest.rhythm}`, "");
  }
  if (manifest.patterns && manifest.patterns.length > 0) {
    hasContent = true;
    lines.push("Patterns:");
    for (const p of manifest.patterns) {
      lines.push(
        `- **${p.name}**${p.moduleType ? ` (module type \`${p.moduleType}\`)` : ""} — ${p.spec}`,
      );
    }
    lines.push("");
  }
  if (manifest.imagery) {
    hasContent = true;
    lines.push(`Imagery: ${manifest.imagery}`, "");
  }
  if (manifest.avoid) {
    hasContent = true;
    lines.push(`Never: ${manifest.avoid}`, "");
  }
  if (!hasContent) return null;
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
