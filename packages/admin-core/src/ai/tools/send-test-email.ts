// SPDX-License-Identifier: MPL-2.0

/**
 * `send_test_email` — the AI's side of the "Send test" button on
 * Security → Email (`email_config.send_test`). Sends the fixed transport
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
      .describe("Recipient — must be an address on the sender's (fromAddress) domain."),
  })
  .strict();

type SendTestEmailInput = z.infer<typeof sendTestEmailInput>;

export const sendTestEmailTool: ToolDefinitionWithHandler<SendTestEmailInput> = {
  name: "send_test_email",
  description:
    "Send the fixed 'Caelo email transport test' message through the site's configured email transport and report whether the provider accepted it. " +
    "Use after an email config change was approved (`propose_set_email_config`), or when password-reset / form emails seem not to arrive. " +
    "The recipient must be on the sender's own domain (e.g. sender noreply@example.com → you may test to team@example.com); for any other address, tell the operator to send the test from Security → Email. " +
    "Subject and body are fixed — this cannot send custom mail. A failure names the provider's reason (bad API key, unverified sender domain, transport 'none'); relay it rather than retrying unchanged.",
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
