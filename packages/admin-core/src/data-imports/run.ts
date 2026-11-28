// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: one import call, start to end (docs/data-imports.md).
 *
 *   1. Read the rows: from the call, or from uploaded files (CSV, JSON
 *      Lines, JSON). The bytes go from the store to here, never through
 *      the model; it only reads the report.
 *   2. Refuse columns the kind does not take (an e-mail address, an IP).
 *   3. Check every row against the kind's fields; find duplicates.
 *   4. Look up what earlier imports hold and which pages the rows name.
 *   5. Resolve parents, refuse cycles and orphans.
 *   6. Unless it is a dry run, or rows have problems and the call did not
 *      say `skipInvalid`: open the import, let the kind write its rows
 *      parents first, keep the rows the kind stored, keep the report.
 *
 * The steps that write run as their own transactions (the kind's own
 * operations, a plugin's apply operation). A call that stops halfway is
 * repeated: row ids are derived from the import and the `sourceKey`, so a
 * kind overwrites what the first try stored instead of storing it twice.
 */

import type { PluginInvocation } from "@caelo-cms/plugin-sdk";
import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import {
  type CheckedImportRow,
  checkImportRow,
  type DataFileFormat,
  decodeDataFile,
  type ExecutionContext,
  type ImportCounts,
  type ImportProblemGroup,
  ImportProblems,
  type ImportValue,
  type MediaStorageAdapter,
  parseDataFile,
  unknownImportFields,
} from "@caelo-cms/shared";
import { describeError } from "../ai/tools/_describe-error.js";
import { systemContextOf } from "../deploy/generator-subprocess.js";
import { LOOKUP_CHUNK, RECORD_CHUNK } from "../ops/data_imports.js";
import { importRowDigest, importRowId } from "./ids.js";
import { type ImportKind, type ImportWriteRow, importKinds } from "./kinds.js";

/** Most rows one call takes inline; more go through a file. */
export const MAX_INLINE_ROWS = 200;

/** Most files one call reads. */
export const MAX_UPLOADS_PER_CALL = 20;

/** What the pipeline needs of its surroundings. */
export interface DataImportDeps {
  readonly registry: OperationRegistry;
  readonly adapter: DatabaseAdapter;
  readonly storage: () => MediaStorageAdapter;
  /** The kinds to import into; the active ones ({@link importKinds}) unless a test names others. */
  readonly kinds?: () => readonly ImportKind[];
}

/** Who imports: the op context, and the plugin invocation for plugin kinds. */
export interface DataImportCaller {
  readonly ctx: ExecutionContext;
  readonly invocation: PluginInvocation;
  readonly chatSessionId?: string;
}

/** One import call. */
export interface DataImportInput {
  readonly kind: string;
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  readonly uploadIds?: readonly string[];
  readonly sourceLabel?: string;
  readonly importId?: string;
  readonly dryRun?: boolean;
  /** `skip` (default): leave rows the import already holds. `update`: overwrite them. */
  readonly mode?: "skip" | "update";
  /** Write the rows without problems even when others have some. */
  readonly skipInvalid?: boolean;
}

/** What a call did. */
export interface DataImportReport {
  readonly importId: string | null;
  readonly kind: string;
  readonly dryRun: boolean;
  readonly written: boolean;
  readonly counts: ImportCounts;
  readonly problems: readonly ImportProblemGroup[];
  /** Where the import stands now (`data_imports.get`), when it exists. */
  readonly state: string | null;
  /** What to do next, in one or two sentences. */
  readonly next: string;
}

export type DataImportResult =
  | { readonly ok: true; readonly report: DataImportReport }
  | { readonly ok: false; readonly message: string };

/** A row read from the input, before its checks. */
interface InputRecord {
  readonly at: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** A row that passed its field checks, with everything resolved later. */
interface PlannedRow {
  readonly index: number;
  readonly at: string;
  readonly checked: CheckedImportRow;
  pageId: string | null;
  parentInCall: boolean;
  parentRowId: string | null;
  held: { rowId: string; importId: string; digest: string } | null;
}

function fail(message: string): DataImportResult {
  return { ok: false, message };
}

function kindsOf(deps: DataImportDeps): readonly ImportKind[] {
  return (deps.kinds ?? importKinds)();
}

function kindNamed(deps: DataImportDeps, name: string): ImportKind | undefined {
  return kindsOf(deps).find((k) => k.declaration.kind === name);
}

async function readUploads(
  deps: DataImportDeps,
  caller: DataImportCaller,
  uploadIds: readonly string[],
  problems: ImportProblems,
): Promise<{ records: InputRecord[]; unreadable: number } | { error: string }> {
  const records: InputRecord[] = [];
  let unreadable = 0;
  for (const uploadId of uploadIds) {
    const meta = await execute(deps.registry, deps.adapter, caller.ctx, "data_uploads.get", {
      uploadId,
    });
    if (!meta.ok) return { error: describeError(meta.error) };
    const upload = meta.value as {
      status: string;
      filename: string | null;
      format: DataFileFormat | null;
      storageKey: string | null;
      link: string;
    };
    if (upload.status !== "ready" || !upload.storageKey || !upload.format)
      return {
        error: `upload ${uploadId} is still empty: the operator drops the file at ${upload.link} first`,
      };
    const decoded = decodeDataFile(await deps.storage().get(upload.storageKey));
    if (!decoded.ok) return { error: `${upload.filename}: ${decoded.error}` };
    const parsed = parseDataFile(decoded.text, upload.format);
    if (!parsed.ok) return { error: `${upload.filename}: ${parsed.error}` };
    for (const r of parsed.records)
      records.push({ at: `${upload.filename} ${r.at}`, values: r.values });
    for (const u of parsed.unreadable) {
      unreadable += 1;
      problems.add("unreadable-row", `${upload.filename} ${u.at}`, {
        sourceKey: null,
        at: `${upload.filename} ${u.at}`,
        detail: u.detail,
      });
    }
  }
  return { records, unreadable };
}

/** Parent before child, by depth within the call; cycles are returned as problems. */
function byDepth(rows: readonly PlannedRow[]): { levels: PlannedRow[][]; cyclic: PlannedRow[] } {
  const byKey = new Map(rows.map((r) => [r.checked.sourceKey, r]));
  const depth = new Map<string, number>();
  const cyclic: PlannedRow[] = [];
  for (const row of rows) {
    const seen = new Set<string>();
    let d = 0;
    let cur: PlannedRow | undefined = row;
    while (cur?.parentInCall && cur.checked.parentKey !== null) {
      if (seen.has(cur.checked.sourceKey)) {
        d = -1;
        break;
      }
      seen.add(cur.checked.sourceKey);
      d += 1;
      cur = byKey.get(cur.checked.parentKey);
    }
    if (d < 0) cyclic.push(row);
    else depth.set(row.checked.sourceKey, d);
  }
  const levels: PlannedRow[][] = [];
  for (const row of rows) {
    const d = depth.get(row.checked.sourceKey);
    if (d === undefined) continue;
    const level = levels[d] ?? [];
    level.push(row);
    levels[d] = level;
  }
  return { levels: levels.filter((l) => l !== undefined), cyclic };
}

function pageRefField(kind: ImportKind): string | null {
  const hit = Object.entries(kind.declaration.fields).find(([, f]) => f.type === "pageRef");
  return hit ? hit[0] : null;
}

/** Runs one import call (see the file comment). */
export async function runDataImport(
  deps: DataImportDeps,
  caller: DataImportCaller,
  input: DataImportInput,
): Promise<DataImportResult> {
  const kind = kindNamed(deps, input.kind);
  if (!kind)
    return fail(
      `there is no import kind "${input.kind}" now; the active ones are: ${kindsOf(deps)
        .map((k) => k.declaration.kind)
        .join(", ")}`,
    );
  const decl = kind.declaration;
  const parents = decl.parents === true;
  const dryRun = input.dryRun === true;
  const mode = input.mode ?? "skip";
  const problems = new ImportProblems();
  const rowsGiven = (input.rows?.length ?? 0) > 0;
  const uploadsGiven = (input.uploadIds?.length ?? 0) > 0;
  if (rowsGiven === uploadsGiven)
    return fail(
      "send either `rows` (at most 200, for small lists) or `uploadIds` (files), not both and not neither",
    );
  if ((input.rows?.length ?? 0) > MAX_INLINE_ROWS)
    return fail(
      `${input.rows?.length} rows inline; at most ${MAX_INLINE_ROWS}. Write the rows to a CSV or JSON Lines file and upload it (caelo_upload_data, or request_data_upload for a link)`,
    );
  if ((input.uploadIds?.length ?? 0) > MAX_UPLOADS_PER_CALL)
    return fail(`at most ${MAX_UPLOADS_PER_CALL} files per call`);
  if (!input.importId && !input.sourceLabel)
    return fail('name where the rows come from in `sourceLabel` (e.g. "WordPress example.com")');

  // 1. Rows.
  let records: InputRecord[];
  let unreadable = 0;
  if (rowsGiven) {
    records = (input.rows ?? []).map((values, i) => ({ at: `row ${i + 1}`, values }));
  } else {
    const read = await readUploads(deps, caller, input.uploadIds ?? [], problems);
    if ("error" in read) return fail(read.error);
    records = read.records;
    unreadable = read.unreadable;
  }
  if (records.length === 0 && unreadable === 0) return fail("the input holds no rows");

  // 2. Columns the kind does not take refuse the call as a whole.
  const keys = new Set<string>();
  for (const r of records) for (const k of Object.keys(r.values)) keys.add(k);
  const unknown = unknownImportFields(decl.fields, parents, keys);
  if (unknown.length > 0)
    return fail(
      `${decl.kind} rows take only ${["sourceKey", ...(parents ? ["parentKey"] : []), ...Object.keys(decl.fields)].join(", ")}; drop ${unknown.join(", ")} (Caelo keeps no other data, e-mail and IP addresses included) and send again`,
    );

  // 3. Field checks and duplicates.
  const planned: PlannedRow[] = [];
  const seenKeys = new Set<string>();
  for (const [index, r] of records.entries()) {
    const id = `${index}`;
    const checked = checkImportRow(decl.fields, parents, r.values);
    if (!checked.ok) {
      for (const p of checked.problems)
        problems.add(p.reason, id, { sourceKey: checked.sourceKey, at: r.at, detail: p.detail });
      continue;
    }
    if (seenKeys.has(checked.row.sourceKey)) {
      problems.add("duplicate-source-key", id, {
        sourceKey: checked.row.sourceKey,
        at: r.at,
        detail: "the sourceKey appears earlier in the input",
      });
      continue;
    }
    seenKeys.add(checked.row.sourceKey);
    planned.push({
      index,
      at: r.at,
      checked: checked.row,
      pageId: null,
      parentInCall: false,
      parentRowId: null,
      held: null,
    });
  }

  // 4. What earlier imports hold, and the pages.
  const refField = pageRefField(kind);
  const lookupKeys = new Set<string>();
  for (const p of planned) {
    lookupKeys.add(p.checked.sourceKey);
    if (p.checked.parentKey && !seenKeys.has(p.checked.parentKey))
      lookupKeys.add(p.checked.parentKey);
  }
  const refs = new Set<string>();
  if (refField)
    for (const p of planned) {
      const v = p.checked.values[refField];
      if (typeof v === "string") refs.add(v);
    }
  const held = new Map<string, { rowId: string; importId: string; digest: string }>();
  const pages = new Map<string, string>();
  const keyList = [...lookupKeys];
  const refList = [...refs];
  for (let i = 0; i < Math.max(keyList.length, refList.length); i += LOOKUP_CHUNK) {
    const r = await execute(deps.registry, deps.adapter, caller.ctx, "data_imports.lookup", {
      owner: kind.owner,
      kind: decl.kind,
      sourceKeys: keyList.slice(i, i + LOOKUP_CHUNK),
      pageRefs: refList.slice(i, i + LOOKUP_CHUNK),
    });
    if (!r.ok) return fail(describeError(r.error));
    const v = r.value as {
      held: { sourceKey: string; rowId: string; importId: string; digest: string }[];
      pages: { ref: string; pageId: string }[];
    };
    for (const h of v.held) held.set(h.sourceKey, h);
    for (const p of v.pages) pages.set(p.ref, p.pageId);
  }
  for (const p of planned) {
    p.held = held.get(p.checked.sourceKey) ?? null;
    if (refField) {
      const v = p.checked.values[refField];
      if (typeof v === "string") {
        const pageId = pages.get(v);
        if (pageId) p.pageId = pageId;
        else
          problems.add("page-not-found", `${p.index}`, {
            sourceKey: p.checked.sourceKey,
            at: p.at,
            detail: `no page at ${v}: build or move the page first, or add a redirect from that address`,
          });
      }
    }
  }

  // 5. Parents: in this call (and fine), or held by an earlier import.
  const inCall = new Map(planned.map((p) => [p.checked.sourceKey, p]));
  for (const p of planned) {
    const parentKey = p.checked.parentKey;
    if (parentKey === null) continue;
    if (inCall.has(parentKey)) p.parentInCall = true;
    else {
      const h = held.get(parentKey);
      if (h) p.parentRowId = h.rowId;
      else
        problems.add("parent-not-found", `${p.index}`, {
          sourceKey: p.checked.sourceKey,
          at: p.at,
          detail: `parent ${parentKey} is neither in this input nor imported: add it, or send the row without parentKey`,
        });
    }
  }
  const { levels, cyclic } = byDepth(planned);
  for (const p of cyclic)
    problems.add("parent-not-found", `${p.index}`, {
      sourceKey: p.checked.sourceKey,
      at: p.at,
      detail: "its parentKey chain loops back to it",
    });
  // A row whose parent has a problem cannot be written either.
  for (const level of levels)
    for (const p of level) {
      const parent = p.parentInCall && p.checked.parentKey ? inCall.get(p.checked.parentKey) : null;
      if (parent && problems.has(`${parent.index}`) && !problems.has(`${p.index}`))
        problems.add("parent-not-found", `${p.index}`, {
          sourceKey: p.checked.sourceKey,
          at: p.at,
          detail: `its parent ${parent.checked.sourceKey} has a problem itself`,
        });
    }

  // Rows another import holds stay as they are; this import's own rows are
  // compared after the ids are known (they depend on the import).
  const targetImportId = input.importId ?? null;
  const isOwn = (p: PlannedRow) => p.held !== null && p.held.importId === targetImportId;
  const ok = (p: PlannedRow) => !problems.has(`${p.index}`);
  const heldElsewhere = planned.filter((p) => ok(p) && p.held !== null && !isOwn(p));
  const candidates = levels.flat().filter((p) => ok(p) && (p.held === null || isOwn(p)));

  const invalid = problems.rowCount;
  const blocked = invalid > 0 && input.skipInvalid !== true;
  const base = {
    rows: records.length + unreadable,
    invalid,
  };
  if (dryRun || blocked) {
    const counts = {
      ...base,
      imported: candidates.filter((p) => p.held === null).length,
      updated: mode === "update" ? candidates.filter((p) => p.held !== null).length : 0,
      unchanged:
        heldElsewhere.length +
        (mode === "update" ? 0 : candidates.filter((p) => p.held !== null).length),
    };
    return {
      ok: true,
      report: {
        importId: targetImportId,
        kind: decl.kind,
        dryRun,
        written: false,
        counts,
        problems: problems.groups(),
        state: null,
        next: blocked
          ? `Nothing was written: ${invalid} rows have problems. Fix them at the cause (the conversion or the mapping) and call again, or send skipInvalid: true to import the others.`
          : `A dry run: nothing was written. Call again without dryRun to import ${counts.imported + counts.updated} rows.`,
      },
    };
  }

  // 6. Write.
  const opened = await execute(deps.registry, deps.adapter, caller.ctx, "data_imports.open", {
    owner: kind.owner,
    kind: decl.kind,
    release: decl.release,
    sourceLabel: input.sourceLabel ?? decl.label,
    ...(input.importId ? { importId: input.importId } : {}),
    ...(caller.chatSessionId ? { chatSessionId: caller.chatSessionId } : {}),
  });
  if (!opened.ok) return fail(describeError(opened.error));
  const importId = (opened.value as { importId: string }).importId;

  let imported = 0;
  let updated = 0;
  let unchanged = heldElsewhere.length;
  const items: {
    rowId: string;
    sourceKey: string;
    parentRowId: string | null;
    pageId: string | null;
    values: Record<string, ImportValue | null>;
    digest: string;
    targetRef: string | null;
  }[] = [];
  let writeError: string | null = null;
  outer: for (const level of levels) {
    const writes: (ImportWriteRow & { digest: string })[] = [];
    for (const p of level) {
      if (!ok(p) || (p.held !== null && !isOwn(p))) continue;
      const rowId = importRowId(importId, p.checked.sourceKey);
      const parentRowId =
        p.parentInCall && p.checked.parentKey
          ? importRowId(importId, p.checked.parentKey)
          : p.parentRowId;
      const digest = importRowDigest({ parentRowId, pageId: p.pageId, values: p.checked.values });
      if (p.held !== null && (mode === "skip" || p.held.digest === digest)) {
        unchanged += 1;
        continue;
      }
      writes.push({
        rowId,
        sourceKey: p.checked.sourceKey,
        parentRowId,
        pageId: p.pageId,
        values: p.checked.values,
        update: p.held !== null,
        digest,
      });
    }
    for (let i = 0; i < writes.length; i += kind.writeBatch) {
      const batch = writes.slice(i, i + kind.writeBatch);
      const w = await kind.write(
        {
          registry: deps.registry,
          adapter: deps.adapter,
          ctx: caller.ctx,
          invocation: caller.invocation,
        },
        importId,
        batch.map(({ digest: _digest, ...row }) => row),
      );
      if (!w.ok) {
        writeError = w.message;
        break outer;
      }
      const refusedIds = new Map(w.refused.map((r) => [r.rowId, r.detail]));
      for (const row of batch) {
        const refusal = refusedIds.get(row.rowId);
        if (refusal !== undefined) {
          problems.add("refused", `w${row.rowId}`, {
            sourceKey: row.sourceKey,
            at: "",
            detail: refusal,
          });
          continue;
        }
        if (!w.written.has(row.rowId)) continue;
        if (row.update) updated += 1;
        else imported += 1;
        items.push({
          rowId: row.rowId,
          sourceKey: row.sourceKey,
          parentRowId: row.parentRowId,
          pageId: row.pageId,
          values: { ...row.values },
          digest: row.digest,
          targetRef: w.written.get(row.rowId) ?? null,
        });
      }
    }
  }
  const counts: ImportCounts = {
    ...base,
    imported,
    updated,
    unchanged,
    invalid: problems.rowCount,
  };
  const report = {
    dryRun: false,
    written: items.length > 0,
    counts,
    problems: problems.groups(),
  };
  for (let i = 0; i === 0 || i < items.length; i += RECORD_CHUNK) {
    const last = i + RECORD_CHUNK >= items.length;
    const rec = await execute(deps.registry, deps.adapter, caller.ctx, "data_imports.record", {
      importId,
      items: items.slice(i, i + RECORD_CHUNK),
      ...(last ? { report } : {}),
    });
    if (!rec.ok)
      return fail(
        `the rows were written but not recorded: ${describeError(rec.error)}. Call again with importId ${importId}`,
      );
  }
  if (writeError !== null)
    return fail(
      `the import stopped after ${imported + updated} rows: ${writeError}. Fix it and call again with importId ${importId}; rows already written are kept`,
    );
  if (uploadsGiven && problems.rowCount === 0) {
    const forgotten = await execute(
      deps.registry,
      deps.adapter,
      systemContextOf(caller.ctx),
      "data_uploads.forget",
      { uploadIds: [...(input.uploadIds ?? [])] },
    );
    if (forgotten.ok)
      for (const key of (forgotten.value as { storageKeys: string[] }).storageKeys)
        await deps.storage().delete(key);
  }
  const state = await execute(deps.registry, deps.adapter, caller.ctx, "data_imports.get", {
    importId,
  });
  const stateName = state.ok ? (state.value as { state: string }).state : null;
  return {
    ok: true,
    report: {
      importId,
      kind: decl.kind,
      dryRun: false,
      written: items.length > 0,
      counts,
      problems: problems.groups(),
      state: stateName,
      next:
        decl.release === "stage"
          ? "Editors see the rows now. They reach staging with the next Stage of this chat and the live site with Publish live; undo_data_import takes them back."
          : "Saved as pending changes of their kind; undo_data_import takes them back.",
    },
  };
}

/** What an undo did. */
export interface DataImportUndo {
  readonly importId: string;
  readonly state: string;
  readonly message: string;
}

/**
 * Undoes an import. Before any build carried it, and always for kinds with
 * release `target`, the kind removes its rows now. Otherwise the rows stay
 * until the undo ships: staging drops them with the next Stage, the live
 * site with Publish live (and a rollback past it brings them back, like any
 * other change of that release).
 */
export async function undoDataImport(
  deps: DataImportDeps,
  caller: DataImportCaller,
  importId: string,
): Promise<{ ok: true; undo: DataImportUndo } | { ok: false; message: string }> {
  const got = await execute(deps.registry, deps.adapter, caller.ctx, "data_imports.get", {
    importId,
  });
  if (!got.ok) return { ok: false, message: describeError(got.error) };
  const imp = got.value as {
    kind: string;
    owner: string;
    release: "stage" | "target";
    stamped: boolean;
    undoneAt: string | null;
  };
  if (imp.undoneAt !== null) return { ok: false, message: `import ${importId} was already undone` };
  const removeNow = imp.release === "target" || !imp.stamped;
  const kind = kindNamed(deps, imp.kind);
  if (removeNow && (!kind || kind.owner !== imp.owner))
    return {
      ok: false,
      message: `the ${imp.kind} kind is not available (its plugin is not active): activate ${imp.owner} to undo this import`,
    };
  // What the kind stored, read before the undo forgets the rows.
  const refs: (string | null)[] = [];
  if (removeNow) {
    let after: string | undefined;
    for (;;) {
      const page = await execute(
        deps.registry,
        deps.adapter,
        caller.ctx,
        "data_imports.item_refs",
        {
          importId,
          ...(after ? { afterRowId: after } : {}),
        },
      );
      if (!page.ok) return { ok: false, message: describeError(page.error) };
      const got = (page.value as { refs: { rowId: string; targetRef: string | null }[] }).refs;
      for (const r of got) refs.push(r.targetRef);
      if (got.length === 0) break;
      after = got[got.length - 1]?.rowId;
    }
  }
  const marked = await execute(
    deps.registry,
    deps.adapter,
    caller.ctx,
    "data_imports.mark_undone",
    {
      importId,
      rowsRemoved: removeNow,
      ...(caller.chatSessionId ? { chatSessionId: caller.chatSessionId } : {}),
    },
  );
  if (!marked.ok) return { ok: false, message: describeError(marked.error) };
  // Marked first: a build that starts now no longer takes the import.
  if (removeNow && kind)
    await kind.remove(
      {
        registry: deps.registry,
        adapter: deps.adapter,
        ctx: caller.ctx,
        invocation: caller.invocation,
      },
      importId,
      refs,
    );
  const state = (marked.value as { state: string }).state;
  return {
    ok: true,
    undo: {
      importId,
      state,
      message: removeNow
        ? "Undone: the rows are removed."
        : "Undone: the rows leave staging with the next Stage of this chat and the live site with Publish live.",
    },
  };
}
