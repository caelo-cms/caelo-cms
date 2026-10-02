// SPDX-License-Identifier: MPL-2.0

/**
 * `plugin_fonts.read` — a plugin's read access to the shared font library
 * (CMS_REQUIREMENTS §14.5 `font_assets`). One system operation checks, in
 * the same transaction as the read, that the plugin holds `font_assets`
 * for exactly the running artifact (the private-storage grant check), and
 * then runs the requested `fonts.*` read operation. Composing the font
 * operations here, as the bulk and pending operations do, keeps the read
 * inside the Query API instead of calling handlers from the broker.
 *
 * Read-only: plugins never import or change fonts.
 */

import { findFontsOp, inspectFontOp, readFontOp, resolveFontOp } from "@caelo-cms/font-service";
import {
  defineOperation,
  type OperationDefinition,
  type OperationRegistry,
} from "@caelo-cms/query-api";
import { type ExecutionContext, err } from "@caelo-cms/shared";
import { z } from "zod";
import { privateGrantRefusal } from "./private-storage.js";

export const FONT_READ_OP = "plugin_fonts.read";

const READS = {
  find: findFontsOp,
  inspect: inspectFontOp,
  resolve: resolveFontOp,
  read_chunk: readFontOp,
} as const;

/** Which font read a plugin asked for. */
export type PluginFontRead = keyof typeof READS;

const readOp = defineOperation({
  name: FONT_READ_OP,
  // Why system-only: the host broker reads on the plugin's behalf, after
  // checking that the operator may author (images.ts does the same).
  actorScope: ["system"],
  database: "cms_admin",
  input: z
    .object({
      pluginId: z.string().uuid(),
      pluginArtifactDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      read: z.enum(["find", "inspect", "resolve", "read_chunk"]),
      input: z.unknown(),
    })
    .strict(),
  output: z.unknown(),
  handler: async (ctx, input, tx) => {
    const pluginCtx: ExecutionContext = {
      ...ctx,
      pluginId: input.pluginId,
      ...(input.pluginArtifactDigest ? { pluginArtifactDigest: input.pluginArtifactDigest } : {}),
    };
    const refused = await privateGrantRefusal(tx, pluginCtx, "font_assets");
    if (refused) {
      return err({ kind: "HandlerError", operation: FONT_READ_OP, message: refused });
    }
    const op = READS[input.read] as OperationDefinition<unknown, unknown>;
    const parsed = op.input.safeParse(input.input);
    if (!parsed.success) {
      return err({
        kind: "HandlerError",
        operation: FONT_READ_OP,
        message: `invalid ${op.name} input: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      });
    }
    return op.handler(ctx, parsed.data, tx);
  },
});

/** Register `plugin_fonts.read` (idempotent, like the storage ops). */
export function registerPluginFontOps(registry: OperationRegistry): void {
  if (registry.has(FONT_READ_OP)) return;
  // The registry stores every op as OperationDefinition<unknown, unknown>.
  registry.register(readOp as OperationDefinition<unknown, unknown>);
}
