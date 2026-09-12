// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import type { PluginPrivateFile, PluginPrivateFiles } from "@caelo-cms/plugin-sdk";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthorDispatchContext, LoadedPlugin, PluginHostInfra } from "./dispatch.js";
import { withExternalAuthorization } from "./external-authorization.js";

type Tx = Parameters<Parameters<PluginHostInfra["adapter"]["withAdminTransaction"]>[1]>[0];
const CHUNK = 262_144;
const QUOTA = 1_073_741_824;
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.object({ id: uuid }).strict();
const offset = z.number().int().min(0).max(20_971_519).multipleOf(CHUNK);
const metadata = identity.extend({
  mediaType: z
    .string()
    .max(127)
    .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
  sizeBytes: z.number().int().min(1).max(20_971_520),
  sha256: digest,
});
const chunkInput = identity.extend({ offset });
const writeInput = chunkInput.extend({ base64: z.string().min(4).max(349_528) });
interface Row {
  id: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  status: "pending" | "ready" | "deleted";
}
function file(row: Row): PluginPrivateFile {
  return {
    id: row.id,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    status: row.status,
  };
}

/** Storage infrastructure: authorization and file writes share the registry lock,
 * like the private query broker. No credentials or host paths enter the SDK.
 */
export function makePluginPrivateFiles(
  plugin: LoadedPlugin,
  infra: PluginHostInfra,
  author: AuthorDispatchContext,
): PluginPrivateFiles {
  uuid.parse(plugin.pluginId);
  uuid.parse(plugin.pluginActorId);
  uuid.parse(author.operatorActorId);
  if (
    !["human", "ai"].includes(author.actor.actorKind) ||
    (author.actor.actorKind === "human" && author.actor.actorId !== author.operatorActorId)
  )
    throw new Error("PrivateFileAuthorIdentityInvalid");
  if (
    !plugin.definition.requestedCapabilities?.includes("private_files") ||
    (plugin.provenance === "runtime-authored" &&
      !plugin.externalApproval?.capabilities.includes("private_files"))
  )
    throw new Error("PrivateFileCapabilityDenied");

  async function access<T>(write: boolean, work: (tx: Tx) => Promise<T>): Promise<T> {
    const perform = async (tx: Tx) => {
      // Even a retained SDK handle must stop when author permissions are removed.
      const authors = (await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM users u
        JOIN user_roles ur ON ur.user_id=u.id JOIN role_permissions rp ON rp.role_id=ur.role_id
        JOIN permissions p ON p.id=rp.permission_id WHERE u.id=${author.operatorActorId}::uuid
        AND u.deleted_at IS NULL AND p.name='content.write') AS allowed`)) as unknown as {
        allowed: boolean;
      }[];
      if (!authors[0]?.allowed) throw new Error("PrivateFileAuthorPermissionDenied");
      if (write) {
        // Serialize quota reservations and chunk/commit/remove races per plugin.
        // Advisory locks do not upgrade the registry FOR SHARE lock used by revocation.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${plugin.pluginId}, 219))`,
        );
      }
      await tx.execute(sql`SELECT set_config('caelo.actor_kind', 'plugin', true),
        set_config('caelo.actor_id', ${plugin.pluginActorId}, true),
        set_config('caelo.plugin_id', ${plugin.pluginId}, true)`);
      return work(tx);
    };
    if (plugin.externalApproval) return withExternalAuthorization(plugin, infra, perform);
    return infra.adapter.withAdminTransaction(
      { actorId: plugin.pluginActorId, actorKind: "system", requestId: "plugin-private-file" },
      async (tx) => {
        const rows = (await tx.execute(
          sql`SELECT status FROM plugins WHERE id=${plugin.pluginId}::uuid FOR SHARE`,
        )) as unknown as { status: string }[];
        if (rows[0]?.status !== "active") throw new Error("PrivateFilePluginInactive");
        return perform(tx);
      },
    );
  }
  async function read(tx: Tx, id: string): Promise<Row> {
    const rows = (await tx.execute(sql`SELECT id::text,media_type,size_bytes,sha256,status
      FROM plugin_private_files WHERE plugin_id=${plugin.pluginId}::uuid AND id=${id}::uuid`)) as unknown as Row[];
    if (!rows[0]) throw new Error("PrivateFileNotFound");
    return rows[0];
  }
  return {
    async begin(input) {
      const value = metadata.parse(input);
      return access(true, async (tx) => {
        const existing = (await tx.execute(sql`SELECT id::text,media_type,size_bytes,sha256,status
          FROM plugin_private_files WHERE plugin_id=${plugin.pluginId}::uuid AND id=${value.id}::uuid`)) as unknown as Row[];
        if (existing[0]) {
          const row = existing[0];
          if (row.status === "deleted") throw new Error("PrivateFileIdentityRetired");
          if (
            row.sha256 !== value.sha256 ||
            row.size_bytes !== value.sizeBytes ||
            row.media_type !== value.mediaType
          )
            throw new Error("PrivateFileIdentityConflict");
          return file(row);
        }
        const usage = (await tx.execute(sql`SELECT coalesce(sum(size_bytes),0)::bigint AS bytes
          FROM plugin_private_files WHERE plugin_id=${plugin.pluginId}::uuid AND status <> 'deleted'`)) as unknown as {
          bytes: string | number;
        }[];
        if (Number(usage[0]?.bytes ?? 0) + value.sizeBytes > QUOTA)
          throw new Error("PrivateFileQuotaExceeded");
        await tx.execute(sql`INSERT INTO plugin_private_files(plugin_id,id,media_type,size_bytes,sha256)
          VALUES (${plugin.pluginId}::uuid,${value.id}::uuid,${value.mediaType},${value.sizeBytes},${value.sha256})`);
        return { ...value, status: "pending" as const };
      });
    },
    async writeChunk(input) {
      const value = writeInput.parse(input);
      const bytes = Buffer.from(value.base64, "base64");
      if (!bytes.length || bytes.length > CHUNK || bytes.toString("base64") !== value.base64)
        throw new Error("PrivateFileInvalidBase64");
      await access(true, async (tx) => {
        const row = await read(tx, value.id);
        if (row.status === "deleted") throw new Error("PrivateFileNotFound");
        if (
          value.offset >= row.size_bytes ||
          bytes.length !== Math.min(CHUNK, row.size_bytes - value.offset)
        )
          throw new Error("PrivateFileChunkSizeMismatch");
        const chunks =
          (await tx.execute(sql`SELECT encode(bytes,'base64') AS bytes FROM plugin_private_file_chunks
          WHERE plugin_id=${plugin.pluginId}::uuid AND file_id=${value.id}::uuid AND offset_bytes=${value.offset}`)) as unknown as {
            bytes: string;
          }[];
        if (chunks[0]) {
          if (!Buffer.from(chunks[0].bytes, "base64").equals(bytes))
            throw new Error("PrivateFileChunkConflict");
          return;
        }
        if (row.status === "ready") throw new Error("PrivateFileImmutable");
        await tx.execute(sql`INSERT INTO plugin_private_file_chunks(plugin_id,file_id,offset_bytes,bytes)
          VALUES (${plugin.pluginId}::uuid,${value.id}::uuid,${value.offset},decode(${value.base64},'base64'))`);
      });
    },
    async commit(input) {
      const { id } = identity.parse(input);
      return access(true, async (tx) => {
        const row = await read(tx, id);
        if (row.status === "deleted") throw new Error("PrivateFileNotFound");
        if (row.status === "ready") return file(row);
        const chunks = (await tx.execute(sql`SELECT offset_bytes,encode(bytes,'base64') AS bytes
          FROM plugin_private_file_chunks WHERE plugin_id=${plugin.pluginId}::uuid AND file_id=${id}::uuid
          ORDER BY offset_bytes`)) as unknown as { offset_bytes: number; bytes: string }[];
        const hash = createHash("sha256");
        let length = 0;
        for (const chunk of chunks) {
          if (chunk.offset_bytes !== length) throw new Error("PrivateFileIncomplete");
          const bytes = Buffer.from(chunk.bytes, "base64");
          hash.update(bytes);
          length += bytes.length;
        }
        if (length !== row.size_bytes) throw new Error("PrivateFileIncomplete");
        if (hash.digest("hex") !== row.sha256) throw new Error("PrivateFileDigestMismatch");
        await tx.execute(sql`UPDATE plugin_private_files SET status='ready'
          WHERE plugin_id=${plugin.pluginId}::uuid AND id=${id}::uuid`);
        return file({ ...row, status: "ready" });
      });
    },
    async remove(input) {
      const { id, sha256 } = identity.extend({ sha256: digest }).parse(input);
      await access(true, async (tx) => {
        const row = await read(tx, id);
        if (row.sha256 !== sha256) throw new Error("PrivateFileIdentityConflict");
        await tx.execute(
          sql`DELETE FROM plugin_private_file_chunks WHERE plugin_id=${plugin.pluginId}::uuid AND file_id=${id}::uuid`,
        );
        // Retain the identity: a referenced version can disappear but can never change bytes.
        await tx.execute(
          sql`UPDATE plugin_private_files SET status='deleted' WHERE plugin_id=${plugin.pluginId}::uuid AND id=${id}::uuid`,
        );
      });
    },
    async stat(input) {
      const { id } = identity.parse(input);
      return access(false, async (tx) => file(await read(tx, id)));
    },
    async readChunk(input) {
      const value = chunkInput.parse(input);
      return access(false, async (tx) => {
        const row = await read(tx, value.id);
        if (row.status !== "ready") throw new Error("PrivateFileNotReady");
        if (value.offset >= row.size_bytes) throw new Error("PrivateFileOffsetOutsideFile");
        const chunks =
          (await tx.execute(sql`SELECT encode(bytes,'base64') AS bytes FROM plugin_private_file_chunks
          WHERE plugin_id=${plugin.pluginId}::uuid AND file_id=${value.id}::uuid AND offset_bytes=${value.offset}`)) as unknown as {
            bytes: string;
          }[];
        if (!chunks[0]) throw new Error("PrivateFileIncomplete");
        return { base64: chunks[0].bytes.replaceAll("\n", "") };
      });
    },
  };
}
