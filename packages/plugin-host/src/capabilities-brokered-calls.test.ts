// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — `ai_provider` and `email` for runtime-installed plugins, and the
 * rules the handles hold for every plugin (principle 1, decision Q2 A). No
 * database: each refusal below happens before the handle touches one.
 *
 * - An installed plugin gets `ctx.ai` and `ctx.email` only from its
 *   receipts; its `ctx.email` has no free-form `send` (decision Q5 A), on
 *   the admin side or the gateway.
 * - No plugin calls the AI from a render or a visitor call, and no plugin
 *   mails from a render, an observer, a batch or a chat.
 * - A `generateObject` schema is bounded before it reaches the provider.
 */

import { describe, expect, it } from "bun:test";
import type {
  PluginContextTier1,
  PluginDefinition,
  PluginInvocation,
  PluginInvocationOrigin,
  PublicOperationDef,
} from "@caelo-cms/plugin-sdk";
import { makePluginContext } from "./capabilities.js";
import type { LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { makePluginEmail } from "./mail-queue.js";
import { makePluginAi, PLUGIN_AI_SCHEMA_MAX_DEPTH } from "./plugin-ai.js";

const actorId = "22222222-2222-4222-8222-222222222222";

/** A provider that fails the test if a refused call ever reaches it. */
const provider = {
  resolve: async () => ({ provider: "test", model: "test-model" }),
  complete: async () => {
    throw new Error("the provider must not be reached");
  },
  generateObject: async () => {
    throw new Error("the provider must not be reached");
  },
};
const ADMIN_INFRA = {
  adapter: { hasAdminDatabase: true } as never,
  registry: {} as never,
  aiProvider: provider as never,
} satisfies PluginHostInfra;
const GATEWAY_INFRA = {
  adapter: { hasAdminDatabase: false } as never,
  registry: {} as never,
} satisfies PluginHostInfra;

const templates = {
  confirm: { subject: "Confirm", body: ["Please confirm."] },
};

function plugin(provenance: LoadedPlugin["provenance"], capabilities: string[]): LoadedPlugin {
  return {
    pluginId: "11111111-1111-4111-8111-111111111111",
    slug: "brokered-probe",
    version: "1.0.0",
    tier: provenance === "runtime-authored" ? 2 : 1,
    provenance,
    pluginActorId: actorId,
    ...(provenance === "runtime-authored"
      ? {
          externalApproval: {
            artifactDigest: "d".repeat(64),
            grantIds: ["1"],
            capabilities: capabilities as never,
            systemActorId: "00000000-0000-0000-0000-00000000ffff",
          },
        }
      : {}),
    definition: {
      slug: "brokered-probe",
      version: "1.0.0",
      tier: provenance === "runtime-authored" ? 2 : 1,
      schema: {},
      operations: {},
      requestedCapabilities: capabilities,
      mailTemplates: templates,
    } as unknown as PluginDefinition,
  };
}

const at = (origin: PluginInvocationOrigin): PluginInvocation =>
  ({ origin, actorId, ...(origin === "chat" ? { operatorActorId: actorId } : {}) }) as never;

/** A visitor call carries the declared operation it serves (dispatch resolves it first). */
const subscribe = { name: "subscribe", kind: "write", writes: [] } as unknown as PublicOperationDef;

async function ctxFor(p: LoadedPlugin, invocation: PluginInvocation, infra = ADMIN_INFRA) {
  return (await makePluginContext({
    plugin: p,
    infra,
    invocation,
    ...(invocation.origin === "visitor" ? { publicOperation: subscribe } : {}),
  })) as PluginContextTier1;
}

describe("#1729 — ctx.ai and ctx.email of a runtime-installed plugin come from its receipts", () => {
  it("attaches both with the receipts, on authoring and unattended calls alike", async () => {
    const p = plugin("runtime-authored", ["ai_provider", "email"]);
    for (const origin of ["owner-panel", "approved", "worker", "system"] as const) {
      const ctx = await ctxFor(p, at(origin));
      expect({ origin, ai: Boolean(ctx.ai), email: Boolean(ctx.email) }).toEqual({
        origin,
        ai: true,
        email: true,
      });
    }
  });

  it("attaches neither without the receipts", async () => {
    const ctx = await ctxFor(plugin("runtime-authored", []), at("worker"));
    expect(ctx.ai).toBeUndefined();
    expect(ctx.email).toBeUndefined();
  });

  it("an installed plugin's handle refuses send, on the admin side and the gateway (Q5 A)", async () => {
    const admin = await ctxFor(plugin("runtime-authored", ["email"]), at("worker"));
    await expect(
      admin.email?.send({
        to: "a@example.com",
        subject: "s",
        html: "<p>x</p>",
      }) as Promise<unknown>,
    ).rejects.toThrow("runtime-installed plugins cannot send free-form mail");
    const gateway = await ctxFor(
      plugin("runtime-authored", ["email"]),
      at("visitor"),
      GATEWAY_INFRA,
    );
    // The gateway gets the queue-only handle for the declared mail blocks.
    expect(gateway.email).toBeDefined();
    expect(gateway.ai).toBeUndefined();
    await expect(
      gateway.email?.send({ to: "a@example.com", subject: "s", html: "x" }) as Promise<unknown>,
    ).rejects.toThrow("cannot send free-form mail");
  });

  it("the gateway has no email handle without the receipt", async () => {
    const ctx = await ctxFor(plugin("runtime-authored", []), at("visitor"), GATEWAY_INFRA);
    expect(ctx.email).toBeUndefined();
  });
});

describe("#1729 — rules every plugin's handles hold (Q2 A)", () => {
  for (const provenance of ["release-signed", "runtime-authored"] as const) {
    it(`${provenance}: no mail from a render, an observer, a batch or a chat`, async () => {
      for (const origin of ["render", "observer", "batch", "chat"] as const) {
        const email = makePluginEmail(plugin(provenance, ["email"]), ADMIN_INFRA, {
          publicAdapter: ADMIN_INFRA.adapter,
          publicSide: false,
          invocation: at(origin),
        });
        await expect(email.queue({ template: "confirm", to: "a@example.com" })).rejects.toThrow(
          `cannot mail from a ${origin} call`,
        );
      }
    });

    it(`${provenance}: no AI from a render or a visitor call`, async () => {
      for (const origin of ["render", "visitor"] as const) {
        const ai = makePluginAi(plugin(provenance, ["ai_provider"]), ADMIN_INFRA, at(origin));
        await expect(ai.complete({ system: "s", messages: [] })).rejects.toThrow(
          `cannot call the AI from a ${origin} call`,
        );
      }
    });
  }

  it("a shipped plugin's send keeps to the same origins", async () => {
    const email = makePluginEmail(plugin("release-signed", ["email"]), ADMIN_INFRA, {
      publicAdapter: ADMIN_INFRA.adapter,
      publicSide: false,
      invocation: at("chat"),
    });
    await expect(
      email.send({ to: "a@example.com", subject: "s", html: "<p>x</p>" }),
    ).rejects.toThrow("cannot mail from a chat call");
  });

  it("queues only the plugin's own templates, to a deliverable address", async () => {
    const email = makePluginEmail(plugin("runtime-authored", ["email"]), ADMIN_INFRA, {
      publicAdapter: ADMIN_INFRA.adapter,
      publicSide: false,
      invocation: at("worker"),
    });
    // Another plugin's template name (the newsletter's) is not this one's.
    await expect(
      email.queue({ template: "confirm_subscription", to: "a@example.com" }),
    ).rejects.toThrow('declares no mail template "confirm_subscription"');
    // Header injection: a line break never reaches the outbox.
    await expect(
      email.queue({ template: "confirm", to: "a@example.com\r\nBcc: b@example.com" }),
    ).rejects.toThrow("not a deliverable address");
  });

  it("a render never mints an unsubscribe link", async () => {
    const email = makePluginEmail(plugin("release-signed", ["email"]), ADMIN_INFRA, {
      publicAdapter: ADMIN_INFRA.adapter,
      publicSide: false,
      invocation: at("render"),
    });
    await expect(email.unsubscribeLink({ recipientId: actorId })).rejects.toThrow(
      "cannot make an unsubscribe link from a render",
    );
  });

  it("a generateObject schema nested too deep is refused before the provider", async () => {
    const ai = makePluginAi(plugin("runtime-authored", ["ai_provider"]), ADMIN_INFRA, at("worker"));
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 5_000; i++) {
      deep = { type: "object", properties: { a: deep } };
    }
    await expect(
      ai.generateObject({ system: "s", messages: [], jsonSchema: deep }),
    ).rejects.toThrow(`nests deeper than ${PLUGIN_AI_SCHEMA_MAX_DEPTH} levels`);
    // Options the handle does not know (a model, a key) are refused, not passed on.
    await expect(
      ai.complete({ system: "s", messages: [], model: "dearest" } as never),
    ).rejects.toThrow("invalid options");
  });
});
