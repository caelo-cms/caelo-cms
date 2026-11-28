// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports: reading an uploaded file into records. Three formats:
 *
 *   - CSV (RFC 4180): a header row of field names, `,` `;` or tab as
 *     separator (read from the header), quoted fields with `""` escapes and
 *     line breaks inside quotes, an optional UTF-8 byte order mark.
 *   - JSON Lines: one JSON object per line.
 *   - JSON: one array of objects.
 *
 * A record that cannot be read (a CSV row with the wrong number of
 * columns, a JSON line that does not parse) is a problem of that record;
 * the file as a whole fails only when nothing in it can be trusted (not
 * UTF-8, an unclosed quote, no header).
 *
 * No dependency: a CSV parser is small enough to own, and every one of
 * its rules is a test in `formats.test.ts`.
 */

/** File formats a data import reads. */
export const DATA_FILE_FORMATS = ["csv", "jsonl", "json"] as const;
export type DataFileFormat = (typeof DATA_FILE_FORMATS)[number];

/** Largest file one upload takes. */
export const MAX_DATA_FILE_BYTES = 10 * 1024 * 1024;

/** Most records one file holds. */
export const MAX_DATA_FILE_RECORDS = 100_000;

/** Most columns (CSV) or distinct keys (JSON) one file has. */
export const MAX_DATA_FILE_COLUMNS = 200;

/** One record of a file, with where it starts (1-based line, or array index for JSON). */
export interface DataFileRecord {
  readonly at: string;
  readonly values: Readonly<Record<string, unknown>>;
}

/** A record the reader could not turn into values. */
export interface DataFileRecordProblem {
  readonly at: string;
  readonly detail: string;
}

export type ParsedDataFile =
  | {
      readonly ok: true;
      readonly columns: readonly string[];
      readonly records: readonly DataFileRecord[];
      readonly unreadable: readonly DataFileRecordProblem[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * Decodes uploaded bytes as UTF-8 text (byte order mark removed). Refuses
 * anything else: a spreadsheet saved as .xlsx, a Latin-1 export, a binary.
 */
export function decodeDataFile(
  bytes: Uint8Array,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  if (bytes.byteLength === 0) return { ok: false, error: "the file is empty" };
  if (bytes.byteLength > MAX_DATA_FILE_BYTES)
    return {
      ok: false,
      error: `the file is ${bytes.byteLength} bytes; split it into files of at most ${MAX_DATA_FILE_BYTES} bytes`,
    };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      error: "the file is not UTF-8 text; export it as UTF-8 CSV, JSON Lines or JSON (not .xlsx)",
    };
  }
  if (text.includes("\u0000")) return { ok: false, error: "the file contains binary data" };
  return { ok: true, text: text.startsWith("﻿") ? text.slice(1) : text };
}

/**
 * The format a file is in, from its name, else from its first character.
 * `null` when neither says it.
 */
export function detectDataFileFormat(filename: string, text: string): DataFileFormat | null {
  const ext = filename.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (ext === "csv" || ext === "tsv" || ext === "txt") return "csv";
  if (ext === "jsonl" || ext === "ndjson") return "jsonl";
  if (ext === "json") return text.trimStart().startsWith("[") ? "json" : "jsonl";
  const first = text.trimStart()[0];
  if (first === "[") return "json";
  if (first === "{") return "jsonl";
  return null;
}

/** Reads a decoded file in the given format. */
export function parseDataFile(text: string, format: DataFileFormat): ParsedDataFile {
  switch (format) {
    case "csv":
      return parseCsv(text);
    case "jsonl":
      return parseJsonLines(text);
    case "json":
      return parseJsonArray(text);
  }
}

const SEPARATORS = [",", ";", "\t"] as const;

/** The separator of a CSV file: the one the header row (outside quotes) uses most; `,` on a tie. */
function csvSeparator(text: string): string {
  const counts = new Map<string, number>(SEPARATORS.map((s) => [s, 0]));
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let best = ",";
  for (const s of SEPARATORS) if ((counts.get(s) ?? 0) > (counts.get(best) ?? 0)) best = s;
  return best;
}

/** One CSV row as read, with the line it starts on. */
interface CsvRow {
  readonly line: number;
  readonly cells: string[];
}

/** Splits CSV text into rows of cells (RFC 4180, LF or CRLF line ends). */
function csvRows(text: string, sep: string): { rows: CsvRow[] } | { error: string } {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (cell !== "" || afterQuote)
        return {
          error: `line ${line}: a quote inside an unquoted field; quote the whole field and double the quote ("")`,
        };
      quoted = true;
      continue;
    }
    if (ch === sep) {
      cells.push(cell);
      cell = "";
      afterQuote = false;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cells.push(cell);
      rows.push({ line: rowLine, cells });
      cells = [];
      cell = "";
      afterQuote = false;
      line++;
      rowLine = line;
      continue;
    }
    if (afterQuote)
      return {
        error: `line ${line}: text after a closing quote; put the separator right after it`,
      };
    cell += ch;
  }
  if (quoted) return { error: `line ${rowLine}: a quoted field is never closed` };
  if (cell !== "" || cells.length > 0) {
    cells.push(cell);
    rows.push({ line: rowLine, cells });
  }
  // A blank line is a row of one empty cell; it carries nothing.
  return { rows: rows.filter((r) => !(r.cells.length === 1 && r.cells[0] === "")) };
}

function parseCsv(text: string): ParsedDataFile {
  const split = csvRows(text, csvSeparator(text));
  if ("error" in split) return { ok: false, error: split.error };
  const [header, ...body] = split.rows;
  if (!header) return { ok: false, error: "the file has no header row" };
  const columns = header.cells.map((c) => c.trim());
  if (columns.length > MAX_DATA_FILE_COLUMNS)
    return {
      ok: false,
      error: `the file has ${columns.length} columns, at most ${MAX_DATA_FILE_COLUMNS} allowed`,
    };
  const empty = columns.indexOf("");
  if (empty >= 0) return { ok: false, error: `header column ${empty + 1} has no name` };
  const dup = columns.find((c, i) => columns.indexOf(c) !== i);
  if (dup !== undefined) return { ok: false, error: `header column "${dup}" appears twice` };
  if (body.length > MAX_DATA_FILE_RECORDS)
    return {
      ok: false,
      error: `the file has ${body.length} rows; split it into files of at most ${MAX_DATA_FILE_RECORDS}`,
    };
  const records: DataFileRecord[] = [];
  const unreadable: DataFileRecordProblem[] = [];
  for (const row of body) {
    const at = `line ${row.line}`;
    if (row.cells.length !== columns.length) {
      unreadable.push({
        at,
        detail: `has ${row.cells.length} fields, the header has ${columns.length}`,
      });
      continue;
    }
    const values: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      values[c] = row.cells[i];
    });
    records.push({ at, values });
  }
  return { ok: true, columns, records, unreadable };
}

/** Collects the keys of JSON records in order of first appearance. */
function keysOf(records: readonly DataFileRecord[]): string[] {
  const seen = new Set<string>();
  for (const r of records) for (const k of Object.keys(r.values)) seen.add(k);
  return [...seen];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finishJson(
  records: DataFileRecord[],
  unreadable: DataFileRecordProblem[],
): ParsedDataFile {
  if (records.length + unreadable.length > MAX_DATA_FILE_RECORDS)
    return {
      ok: false,
      error: `the file has ${records.length + unreadable.length} records; split it into files of at most ${MAX_DATA_FILE_RECORDS}`,
    };
  const columns = keysOf(records);
  if (columns.length > MAX_DATA_FILE_COLUMNS)
    return {
      ok: false,
      error: `the records have ${columns.length} distinct keys, at most ${MAX_DATA_FILE_COLUMNS} allowed`,
    };
  return { ok: true, columns, records, unreadable };
}

function parseJsonLines(text: string): ParsedDataFile {
  const records: DataFileRecord[] = [];
  const unreadable: DataFileRecordProblem[] = [];
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    if (raw.trim() === "") continue;
    const at = `line ${i + 1}`;
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      unreadable.push({ at, detail: "is not valid JSON" });
      continue;
    }
    if (!isRecord(v)) {
      unreadable.push({ at, detail: "is not a JSON object" });
      continue;
    }
    records.push({ at, values: v });
  }
  return finishJson(records, unreadable);
}

function parseJsonArray(text: string): ParsedDataFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      error: `the file is not valid JSON (${e instanceof Error ? e.message : "parse error"})`,
    };
  }
  if (!Array.isArray(v)) return { ok: false, error: "a JSON file must hold one array of objects" };
  const records: DataFileRecord[] = [];
  const unreadable: DataFileRecordProblem[] = [];
  for (const [i, item] of v.entries()) {
    const at = `item ${i + 1}`;
    if (!isRecord(item)) unreadable.push({ at, detail: "is not a JSON object" });
    else records.push({ at, values: item });
  }
  return finishJson(records, unreadable);
}
