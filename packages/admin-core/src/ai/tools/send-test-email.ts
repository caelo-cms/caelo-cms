// SPDX-License-Identifier: MPL-2.0

/**
 * `send_test_email` — the AI's side of the "Send test" button on
 * Settings → Email (`email_config.send_test`). Sends the fixed transport
 * self-test message through the currently stored email config, so the AI
 * can confirm a transport it just proposed (`propose_set_email_config`)
 * actually delivers — without the operator switching to the panel.
 *
 * The op restricts AI-triggered tests to recipients on the sender's own
 * domain; the description says so up front so the AI picks a valid
 * address instead of discovering the rule by failing.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const sendTestEmailInput = z
  .object({
    to: z
      .string()
      .email()
      .max(254)
      .describe(
        "Must be on the sender's (fromAddress) domain (sender noreply@example.com -> team@example.com ok); other addresses -> tell the operator to test from Settings -> Email.",
      ),
  })
  .strict();

type SendTestEmailInput = z.infer<typeof sendTestEmailInput>;

export const sendTestEmailTool: ToolDefinitionWithHandler<SendTestEmailInput> = {
  name: "send_test_email",
  description:
    "Send the fixed 'Caelo email transport test' message (no custom mail) via the configured transport; reports whether the provider accepted it. Use after an approved `propose_set_email_config`, or when reset/form emails don't arrive. A failure names the provider's reason (bad API key, unverified sender domain, transport 'none') — relay it, don't retry unchanged.",
  schema: sendTestEmailInput,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "email_config.send_test", {
      to: input.to,
    });
    if (!r.ok) {
      return { ok: false, content: `Test email not sent: ${describeError(r.error)}` };
    }
    const v = r.value as { messageId: string; transport: string };
    return {
      ok: true,
      content: `Test email accepted by the ${v.transport} transport for ${input.to} (message id ${v.messageId}). Ask the operator to confirm it arrived — acceptance is not delivery.`,
    };
  },
};
