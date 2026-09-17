// SPDX-License-Identifier: MPL-2.0
import { findFontsOp, inspectFontOp, readFontOp, resolveFontOp } from "@caelo-cms/font-service";
import type { PluginFonts } from "@caelo-cms/plugin-sdk";
import type { OperationDefinition, TransactionRunner } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import type { AuthorDispatchContext, LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { withExternalAuthorization } from "./external-authorization.js";

/** Both plugin origins use this broker. Every call rechecks live installation
 * and operator permission while holding the authorization lock through the read. */
export function makePluginFonts(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  author: AuthorDispatchContext,
): PluginFonts {
  if (
    !plugin.definition.requestedCapabilities?.includes("font_assets") ||
    (plugin.provenance === "runtime-authored" &&
      !plugin.externalApproval?.capabilities.includes("font_assets")) ||
    !["human", "ai"].includes(author.actor.actorKind) ||
    (author.actor.actorKind === "human" && author.actor.actorId !== author.operatorActorId)
  )
    throw new Error("PluginFontCapabilityDenied");
  async function run<I, O>(op: OperationDefinition<I, O>, input: unknown): Promise<O> {
    const value = op.input.parse(input);
    const work = async (tx: TransactionRunner) => {
      const rows = (await tx.execute(sql`SELECT EXISTS(SELECT 1 FROM users u
        JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id
        JOIN permissions p ON p.id=rp.permission_id WHERE u.id=${author.operatorActorId}::uuid
        AND u.deleted_at IS NULL AND p.name='content.write') AS allowed`)) as unknown as {
        allowed: boolean;
      }[];
      if (!rows[0]?.allowed) throw new Error("PluginFontAuthorPermissionDenied");
      const result = await op.handler(author.actor, value, tx);
      if (!result.ok) throw new Error("PluginFontOperationFailed");
      return result.value;
    };
    if (plugin.externalApproval) return withExternalAuthorization(plugin, infra, work);
    return infra.adapter.withAdminTransaction(
      { actorId: plugin.pluginActorId, actorKind: "system", requestId: "plugin-font" },
      async (tx) => {
        const rows = (await tx.execute(
          sql`SELECT status FROM plugins WHERE id=${plugin.pluginId}::uuid FOR SHARE`,
        )) as unknown as { status: string }[];
        if (rows[0]?.status !== "active") throw new Error("PluginFontInactive");
        return work(tx);
      },
    );
  }
  return Object.freeze<PluginFonts>({
    find: (input) => run(findFontsOp, input),
    inspect: (input) => run(inspectFontOp, input),
    resolve: (input) => run(resolveFontOp, input),
    readChunk: (input) => run(readFontOp, input),
  });
}
