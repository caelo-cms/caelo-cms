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
        "Gate: 'publish' (default; Publish live / promote) -> a link to an unpublished page blocks; 'stage' -> only a warning.",
      ),
    pagePath: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        "Only this page's problems (path, e.g. '/about'); site-wide places (menus, plugin data) always included.",
      ),
    blockingOnly: z.boolean().optional(),
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
    "Check internal links (to own pages/media) in your draft, wherever stored: page content, module HTML, field defaults, layouts, templates, lists (menus, vocabularies), page terms/properties, plugin data. Each problem names the page, storage place and fixing tool.\n" +
    "Severity: BLOCK Stage + Publish = links to deleted pages/media, links without a page in the linking page's language, refs to a deleted list, removed term or deleted module in a list entry. BLOCK Publish (Stage warning) = links to unpublished pages. Warning = old plain-path links.\n" +
    "USE FOR: before `stage_changes` after deleting/unpublishing/translating pages; a Stage refused for links; operator asks about broken links.\n" +
    "DO NOT USE FOR: external links or the built site (`get_quality_audit` checks the staged build).",
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
