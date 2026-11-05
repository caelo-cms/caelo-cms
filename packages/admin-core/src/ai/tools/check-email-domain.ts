// SPDX-License-Identifier: MPL-2.0

/**
 * `check_email_domain` — the DNS records the mail provider needs for the
 * site's sending domain, with the provider's status of each (issue #1337,
 * epic #763 E12). The AI walks the operator through creating them at their
 * registrar and re-checks until the provider reports the domain verified;
 * the same records show on Settings → Email (`email_config.sender_domain`).
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError, toolError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const checkEmailDomainInput = z
  .object({
    verify: z
      .boolean()
      .describe(
        "true after the operator says they created the records: asks the provider to check them now (results follow within a minute, call again with false to read them).",
      ),
  })
  .strict();

type CheckEmailDomainInput = z.infer<typeof checkEmailDomainInput>;

interface SenderDomainResult {
  readonly found: boolean;
  readonly domain: string;
  readonly status?: string;
  readonly verificationStarted?: boolean;
  readonly records?: ReadonlyArray<{
    purpose: string;
    type: string;
    name: string;
    value: string;
    priority: number | null;
    status: string;
  }>;
}

export const checkEmailDomainTool: ToolDefinitionWithHandler<CheckEmailDomainInput> = {
  name: "check_email_domain",
  description:
    "List the DNS records (SPF, DKIM, return-path MX) the mail provider needs for the site's sending domain and whether each is verified. Use after the transport is set up (`propose_set_email_config`) and before activating a plugin that sends mail, or when mails don't arrive: give the operator the records that are not verified to create at their registrar, then call again with verify: true. Only the Resend transport is supported.",
  schema: checkEmailDomainInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "email_config.sender_domain", {
      verify: input.verify,
    });
    if (!r.ok) return toolError(r.error, `Sending domain not checked: ${describeError(r.error)}`);
    const v = r.value as SenderDomainResult;
    if (!v.found) {
      return {
        ok: true,
        content: `The mail provider does not know the domain ${v.domain} yet. The operator adds it in the provider's dashboard (Resend → Domains → Add domain); then call check_email_domain again to get its DNS records.`,
      };
    }
    const lines = (v.records ?? []).map(
      (rec) =>
        `- ${rec.purpose} ${rec.type} ${rec.name}${rec.priority !== null ? ` (priority ${rec.priority})` : ""} = ${rec.value} — ${rec.status}`,
    );
    return {
      ok: true,
      content: [
        `Sending domain ${v.domain}: ${v.status}${v.verificationStarted ? " (the provider is checking the records again; read again in a minute)" : ""}.`,
        ...lines,
      ].join("\n"),
    };
  },
};
