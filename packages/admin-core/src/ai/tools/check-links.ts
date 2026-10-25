// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout F) — `check_links`: the AI's read of reference
 * integrity (chat catalogue and Power-MCP, which exposes every built-in
 * tool). It answers what Stage and Publish live will say about the
 * site's internal links before the AI stages, and lists every problem
 * with the place it is stored and the tool that fixes it.
 */

import { z } from "zod";
import { makeReadTool } from "./_make-read-tool.js";

const input = z
  .object({
    for: z
      .enum(["stage", "publish"])
      .optional()
      .describe(
        "Which gate to check for. 'publish' (default): Publish live / promote — a link to an unpublished page blocks. 'stage': such a link is only a warning.",
      ),
    pagePath: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        "Only problems on this page (its path, e.g. '/about'); site-wide places (menus, plugin data) are always included.",
      ),
    blockingOnly: z.boolean().optional().describe("True = only problems that block."),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

type Input = z.infer<typeof input>;

interface Issue {
  severity: "block" | "warning";
  message: string;
  fix: { tool: string; hint: string };
}

export const checkLinksTool = makeReadTool<Input>({
  name: "check_links",
  description:
    "Check the site's internal links (links between its own pages and media) in the draft you see — every place a link is stored: page content, module HTML, field defaults, layouts, templates, lists (menus, vocabularies), page terms and properties, and plugin data. " +
    "Reports links to deleted pages or media, links without a page in the linking page's language, and references to a deleted list, a removed vocabulary entry (term) or a deleted module embedded in a list entry (all BLOCK Stage and Publish live), links to unpublished pages (BLOCK Publish live, a warning at Stage), and old plain-path links (warnings). " +
    "Each problem names the page, where the link is stored and the tool that fixes it. " +
    "Use it before stage_changes when you deleted, unpublished or translated pages, when a Stage was refused for links, or when the operator asks about broken links. " +
    "Not for external links or what the built site serves (get_quality_audit has the staged-build link check).",
  opName: "links.check_references",
  input,
  buildOpInput: (i) => ({
    for: i.for ?? "publish",
    ...(i.pagePath ? { pagePath: i.pagePath } : {}),
    includeWarnings: i.blockingOnly !== true,
    limit: i.limit ?? 100,
  }),
  format: (value) => {
    const v = value as {
      env: string;
      blocking: number;
      warnings: number;
      issues: Issue[];
      truncated: boolean;
    };
    const gate = v.env === "production" ? "Publish live" : "Stage";
    if (v.issues.length === 0) {
      return `No internal-link problems for ${gate}.`;
    }
    const lines = v.issues.map(
      (i, n) => `${n + 1}. [${i.severity}] ${i.message} → ${i.fix.tool}: ${i.fix.hint}`,
    );
    return (
      `${v.blocking} blocking, ${v.warnings} warning(s) for ${gate}${v.truncated ? " (list truncated — fix these and check again)" : ""}:\n` +
      lines.join("\n")
    );
  },
});
