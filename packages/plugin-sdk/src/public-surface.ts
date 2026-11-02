// SPDX-License-Identifier: MPL-2.0

/**
 * The public-operation contract and the table kinds (issue #1332, epic
 * #763 decisions E4, E10, E12).
 *
 * Everything a visitor can reach is declared here, as data the Owner
 * reviews and the host enforces, never as code:
 *
 * - **Public operations are objects.** `{name, kind, input, captcha,
 *   rateLimit, reads, writes}`. The host validates the visitor's input
 *   against `input` BEFORE the handler runs, so a handler never sees a
 *   value of the wrong type. `captcha` is `"required"` unless the plugin
 *   says `"none"`: a write without a proof-of-work bound to this exact
 *   operation (`<slug>.<name>`) is refused by the host, not by the
 *   plugin. `"none"` is a reviewed declaration in the manifest, never a
 *   runtime switch.
 * - **Every public table has one kind**, and Postgres enforces it with
 *   GRANTs generated from it (plugin-sandbox `publicTableGrants`), because
 *   the public side is assumed compromised
 *   (docs/dev/public-admin-boundary.md):
 *
 *   | kind            | holds                                    | `public_role` may |
 *   |-----------------|------------------------------------------|-------------------|
 *   | `published`     | what the admin decided visitors see      | SELECT            |
 *   | `inbox`         | what visitors send in (submissions)      | INSERT            |
 *   | `visitor-state` | the visitor's own state (accounts, votes) | SELECT, INSERT, UPDATE, DELETE |
 *   | `private`       | internal plugin data                     | nothing           |
 *
 *   The admin keeps full access to all four (it moderates the inbox and
 *   writes the published rows).
 * - **A lint refuses the shapes the GRANTs would break at runtime:** a
 *   public operation reading an inbox or private table, writing a
 *   published or private one, or a `read` operation that writes.
 * - **`requires: ["email"]`** says the plugin cannot work without a mail
 *   transport; activating it without one fails with the setup step.
 *
 * @example
 * ```ts
 * definePlugin({
 *   slug: "reviews", version: "1.0.0", tier: 2,
 *   schema: {
 *     reviews: { page_id: "uuid", stars: "int", body: "text", created_at: "timestamp" },
 *     review_summary: { page_id: "uuid", average: "int" },
 *   },
 *   tableKinds: { reviews: "inbox", review_summary: "published" },
 *   publicOperations: [
 *     {
 *       name: "submit",
 *       kind: "write",
 *       input: z.object({ pageId: z.string().uuid(), stars: z.number().int().min(1).max(5), body: z.string().max(2000) }).strict(),
 *       rateLimit: { max: 5, windowSeconds: 60 },
 *       writes: ["reviews"],
 *     },
 *     { name: "summary", kind: "read", captcha: "none", input: z.object({ pageId: z.string().uuid() }).strict(), reads: ["review_summary"] },
 *   ],
 *   operations: { submit: async (ctx, args) => …, summary: async (ctx, args) => … },
 * });
 * ```
 */

import { z } from "zod";

/** The four kinds a public (`schema`) table can have. */
export const PLUGIN_TABLE_KINDS = ["published", "inbox", "visitor-state", "private"] as const;

/** One table kind. See the table at the top of this file. */
export const pluginTableKind = z.enum(PLUGIN_TABLE_KINDS);

/** One table kind. */
export type PluginTableKind = z.infer<typeof pluginTableKind>;

const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);

/** Table → kind, one entry per table of the plugin's `schema`. */
export const pluginTableKinds = z.record(identifier, pluginTableKind);

/** Table → kind, one entry per table of the plugin's `schema`. */
export type PluginTableKinds = z.infer<typeof pluginTableKinds>;

/** Whether a visitor operation needs a proof-of-work. */
export const publicOperationCaptcha = z.enum(["required", "none"]);

/** `"read"` operations change nothing; `"write"` operations store visitor input. */
export const publicOperationKind = z.enum(["read", "write"]);

/**
 * The per-client-address budget of one operation. The Owner can still
 * override it (`tune_rate_limit`); without either the gateway's default
 * applies (30 per 60 s).
 */
export const publicOperationRateLimit = z
  .object({
    max: z.number().int().min(1).max(10_000),
    windowSeconds: z.number().int().min(1).max(86_400),
  })
  .strict();

/** The per-client-address budget of one operation. */
export type PublicOperationRateLimit = z.infer<typeof publicOperationRateLimit>;

/** Mail is the only host service a plugin can declare it needs (E12). */
export const pluginRequirement = z.enum(["email"]);

/** A host service a plugin needs before it can be activated. */
export type PluginRequirement = z.infer<typeof pluginRequirement>;

/**
 * One public operation as the plugin defines it (`PluginDefinition.
 * publicOperations`). `input` is a Zod schema; the manifest carries its
 * JSON Schema, which is what the Owner reviews and what a sandboxed
 * plugin's host validates against.
 */
export interface PublicOperationDef {
  /** An operation in `operations`. */
  readonly name: string;
  readonly kind: z.infer<typeof publicOperationKind>;
  /**
   * The visitor's request body, validated before the handler runs. Make
   * it `.strict()` and bound every string and array: the body cap is the
   * only other limit. The gateway's proof field (`_caelo_captcha`) is
   * removed before validation; an operation whose component sends the
   * honeypot field (`hp_address`) declares it.
   */
  readonly input: z.ZodType;
  /** Default `"required"`. `"none"` only for reads and writes a rate limit
   *  alone may guard (a consent click); reviewers check every `"none"`. */
  readonly captcha?: z.infer<typeof publicOperationCaptcha>;
  readonly rateLimit?: PublicOperationRateLimit;
  /** Tables of `schema` the handler reads with `ctx.query`. */
  readonly reads?: ReadonlyArray<string>;
  /** Tables of `schema` the handler writes with `ctx.query`. */
  readonly writes?: ReadonlyArray<string>;
}

const operationName = z.string().regex(/^[a-z_][a-z0-9_]{0,119}$/);

/** One public operation as the signed manifest records it. */
export const publicOperationManifest = z
  .object({
    name: operationName,
    kind: publicOperationKind,
    captcha: publicOperationCaptcha,
    rateLimit: publicOperationRateLimit.optional(),
    /** JSON Schema of the operation's input (from `input`). */
    inputJsonSchema: z.record(z.string(), z.unknown()),
    reads: z.array(identifier).max(32),
    writes: z.array(identifier).max(32),
  })
  .strict();

/** One public operation as the signed manifest records it. */
export type PublicOperationManifest = z.infer<typeof publicOperationManifest>;

/** The manifest entry of a defined public operation. */
export function publicOperationManifestOf(op: PublicOperationDef): PublicOperationManifest {
  return {
    name: op.name,
    kind: op.kind,
    captcha: op.captcha ?? "required",
    ...(op.rateLimit ? { rateLimit: { ...op.rateLimit } } : {}),
    // `io: "input"`: what the visitor sends, before any transform.
    inputJsonSchema: z.toJSONSchema(op.input, { io: "input", unrepresentable: "any" }) as Record<
      string,
      unknown
    >,
    reads: [...(op.reads ?? [])],
    writes: [...(op.writes ?? [])],
  };
}

/** The declared public operation `name`, or undefined (default deny). */
export function publicOperationOf<T extends { readonly name: string }>(
  publicOperations: ReadonlyArray<T> | undefined,
  name: string,
): T | undefined {
  return (publicOperations ?? []).find((op) => op.name === name);
}

/** What visitors may do with each kind, as the GRANTs grant it. */
const VISITOR_READABLE: ReadonlySet<PluginTableKind> = new Set(["published", "visitor-state"]);
const VISITOR_WRITABLE: ReadonlySet<PluginTableKind> = new Set(["inbox", "visitor-state"]);

/**
 * The manifest checks of the public surface, shared by the manifest
 * schema (both tiers) and the tests. Reports through `addIssue` like
 * `checkPluginIndexes`.
 */
export function checkPublicSurface(
  m: {
    readonly schema: Readonly<Record<string, unknown>>;
    readonly tableKinds?: Readonly<Record<string, PluginTableKind>>;
    readonly operations: ReadonlyArray<string>;
    readonly publicOperations?: ReadonlyArray<PublicOperationManifest>;
  },
  addIssue: (path: (string | number)[], message: string) => void,
): void {
  const kinds = m.tableKinds ?? {};
  for (const table of Object.keys(m.schema)) {
    if (!(table in kinds)) {
      addIssue(
        ["tableKinds", table],
        `table "${table}" has no kind: declare it in tableKinds as published, inbox, visitor-state or private — the database grants visitors exactly what the kind allows`,
      );
    }
  }
  for (const table of Object.keys(kinds)) {
    if (!(table in m.schema)) {
      addIssue(["tableKinds", table], `tableKinds names "${table}", which schema does not declare`);
    }
  }
  const seen = new Set<string>();
  for (const [i, op] of (m.publicOperations ?? []).entries()) {
    if (seen.has(op.name)) {
      addIssue(["publicOperations", i, "name"], `public operation "${op.name}" is declared twice`);
    }
    seen.add(op.name);
    if (!m.operations.includes(op.name)) {
      addIssue(
        ["publicOperations", i, "name"],
        `public operation "${op.name}" is not one of the plugin's operations`,
      );
    }
    for (const [list, allowed, verb] of [
      ["reads", VISITOR_READABLE, "read"],
      ["writes", VISITOR_WRITABLE, "write"],
    ] as const) {
      for (const [j, table] of op[list].entries()) {
        const kind = kinds[table];
        if (!(table in m.schema)) {
          addIssue(
            ["publicOperations", i, list, j],
            `public operation "${op.name}" ${list} "${table}", which schema does not declare`,
          );
        } else if (kind !== undefined && !allowed.has(kind)) {
          addIssue(
            ["publicOperations", i, list, j],
            `public operation "${op.name}" cannot ${verb} the ${kind} table "${table}": visitors may read only published and visitor-state tables and write only inbox and visitor-state tables`,
          );
        }
      }
    }
    if (op.kind === "read" && op.writes.length > 0) {
      addIssue(
        ["publicOperations", i, "writes"],
        `public operation "${op.name}" is a read but writes ${op.writes.join(", ")}: declare it kind "write"`,
      );
    }
  }
}

/**
 * Throw this from a public operation to tell the VISITOR why their
 * request was refused ("this form is closed", "invalid credentials").
 * Its message reaches the visitor as written; any other error reaches
 * them as a generic refusal, because its text can carry internals (a
 * TypeError, a database message). Keep the message short and free of
 * anything the visitor did not send.
 */
export class PublicOperationError extends Error {
  override readonly name = "PublicOperationError";
}

/** Whether `e` is a {@link PublicOperationError} (also across bundles). */
export function isPublicOperationError(e: unknown): e is PublicOperationError {
  return e instanceof Error && e.name === "PublicOperationError";
}
