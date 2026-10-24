// SPDX-License-Identifier: MPL-2.0

/**
 * `plugins.reload` — "Reload on all servers" for an active plugin (#1008).
 *
 * A plugin that failed to load stays active (the Owner's decision is never
 * undone by an error), and servers do not retry it in a loop. This op is
 * the retry: touching the plugin row changes the state every admin
 * instance fingerprints (plugin-host `reconcile.ts`), so each reconciles on
 * its next check, and each one that does not run the plugin loads it
 * again — recording the new
 * outcome in `plugin_runtime` / `plugin_errors`. This instance reconciles
 * right after the commit, so the caller's next read already shows its
 * result.
 *
 * Routine, all actor kinds (CLAUDE.md §11): it changes no decision and
 * nothing the Owner would need to undo — a reload of a plugin that is
 * running is a no-op on every server.
 */

import { syncPluginHost } from "@caelo-cms/plugin-host";
import { afterCommit, defineOperation } from "@caelo-cms/query-api";
import { err, ok } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../../audit.js";

export const reloadPluginOp = defineOperation({
  name: "plugins.reload",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ slug: z.string().min(1).max(120) }).strict(),
  output: z.object({ slug: z.string() }),
  handler: async (ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      UPDATE plugins SET updated_at = now()
      WHERE slug = ${input.slug} AND status = 'active'
      RETURNING id::text AS id
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) {
      const any = (await tx.execute(sql`
        SELECT status FROM plugins WHERE slug = ${input.slug}
      `)) as unknown as { status: string }[];
      const status = any[0]?.status;
      return err({
        kind: "HandlerError",
        operation: "plugins.reload",
        message:
          status === undefined
            ? `no plugin "${input.slug}" — list_plugins shows the installed plugins and their slugs`
            : `plugin "${input.slug}" is ${status}, not active — a reload only retries an active plugin. ` +
              "Activating it is the Owner's decision (activate_plugin / Settings → Plugins).",
      });
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "plugins.reload",
      input,
      succeeded: true,
      entityId: id,
    });
    afterCommit(tx, {
      label: `reload plugin "${input.slug}" on this server`,
      entityId: id,
      run: () => syncPluginHost(true),
    });
    return ok({ slug: input.slug });
  },
});
