// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1293 — stream filter for the query index gate
 * (docs/dev/query-index-gate.md).
 *
 * Postgres runs with auto_explain logging the plan of every statement and
 * `log_line_prefix='@@%a@@ '`, so every log message starts with
 * "@@<application_name>@@" and its plan lines follow unprefixed. The
 * server's logging collector writes the log into a FIFO this reads
 * (`bun seqscan-filter.ts <> fifo`): the collector reassembles each
 * message, so plans of concurrent backends never interleave the way they do
 * on a plain stderr pipe once a message exceeds PIPE_BUF.
 *
 * The raw log of an integration run is about a gigabyte. This keeps only
 * the plans that (a) ran inside a Database Adapter transaction (tag
 * "caelo/<holder>", packages/query-api/src/statement-tag.ts) and (b) scan a
 * relation without an index condition — a Seq Scan, or an Index (Only) Scan
 * with a Filter but no Index Cond (a whole index walked for its order) —
 * with costs, durations, parameters and output lists removed so repeats
 * collapse to one entry. Each kept entry ends with a line "@@END".
 *
 * It must keep up with the server: a slow reader backs the collector up and
 * with it every backend. So it is linear in the input, and an
 * entry keeps only its first {@link HEAD} lines (the tag and the start of
 * the statement) and its last {@link TAIL} lines (the plan).
 */

import { appendFileSync, writeFileSync } from "node:fs";

const HEAD = 40;
const TAIL = 400;
const STATS_EVERY = 50_000_000;
/** Marks the cut in an entry longer than HEAD + TAIL lines (read by analyze.ts). */
export const TRUNCATED_MARK = "\t@@TRUNCATED";
const DROPPED = /^[ \t]*(Output|Query Identifier|Query Parameters|Buffers|Planning|Execution):/;
const COST = / *\(cost=[^)]*\)/g;
const INDEX_NODE = /Index (Only )?Scan (Backward )?using /;
/** A scan node the analyzer reads (analyze.ts FULL_SCAN). */
const SCAN_NODE = /Seq Scan on |Index (Only )?Scan (Backward )?using /;
/** A plan child starts with "->"; a JSON operator inside a Filter does not. */
export const CHILD_NODE = /^[ \t]*->/;
const SCAN_PROPERTY = /^[ \t]*(Filter|Index Cond):/;

const indentOf = (s: string): number => s.search(/[^ \t]/);

/**
 * The filter's state machine, fed one log line at a time. `emit` receives
 * each kept entry (without the trailing "@@END").
 */
export class SeqScanFilter {
  readonly #seen = new Set<string>();
  readonly #emit: (entry: string) => void;
  #keep = false;
  #head: string[] = [];
  #tail: string[] = [];
  /** Scan nodes and their Filter / Index Cond lines from the cut middle. */
  #middle: string[] = [];
  /** Indent of the scan node last moved to #middle, while its properties follow. */
  #middleScanIndent = -1;
  #count = 0;
  #hasSeq = false;
  #fullIndex = false;
  #inIndex = false;
  #nodeIndent = 0;
  #indexCond = false;
  #indexFilter = false;

  constructor(emit: (entry: string) => void) {
    this.#emit = emit;
  }

  /** Feed one line (without its newline). */
  line(raw: string): void {
    if (raw.startsWith("@@")) {
      this.flush();
      if (raw.startsWith("@@caelo/")) {
        this.#keep = true;
        this.#push(raw.replace(/duration: [0-9.]+ ms */, ""));
      }
      return;
    }
    if (!this.#keep || DROPPED.test(raw)) return;
    const g = raw.replace(COST, "");
    this.#push(g);
    if (g.includes("Seq Scan on ")) this.#hasSeq = true;
    if (this.#inIndex) {
      if (indentOf(g) <= this.#nodeIndent || CHILD_NODE.test(g)) this.#endIndexNode();
      else if (/^[ \t]*Index Cond:/.test(g)) this.#indexCond = true;
      else if (/^[ \t]*Filter:/.test(g)) this.#indexFilter = true;
    }
    if (INDEX_NODE.test(g)) {
      this.#inIndex = true;
      this.#nodeIndent = indentOf(g);
      this.#indexCond = false;
      this.#indexFilter = false;
    }
  }

  /** Close the entry being read: emit it when it is kept and new. */
  flush(): void {
    this.#endIndexNode();
    if (this.#keep && (this.#hasSeq || this.#fullIndex)) {
      // A truncated entry says so: the analyzer fails closed when the cut
      // took the scan it was kept for (analyze.ts, TRUNCATED_MARK).
      const dropped = this.#count - HEAD - TAIL;
      const mark = dropped > 0 ? [`${TRUNCATED_MARK} ${dropped} lines dropped`] : [];
      const entry = [...this.#head, ...mark, ...this.#middle, ...this.#orderedTail()].join("\n");
      if (!this.#seen.has(entry)) {
        this.#seen.add(entry);
        this.#emit(entry);
      }
    }
    this.#keep = false;
    this.#head = [];
    this.#tail = [];
    this.#middle = [];
    this.#middleScanIndent = -1;
    this.#count = 0;
    this.#hasSeq = false;
    this.#fullIndex = false;
  }

  #push(s: string): void {
    if (this.#count < HEAD) this.#head.push(s);
    else {
      const slot = (this.#count - HEAD) % TAIL;
      if (this.#count - HEAD >= TAIL) this.#evict(this.#tail[slot] ?? "");
      this.#tail[slot] = s;
    }
    this.#count++;
  }

  /**
   * A line leaves the kept tail for the cut middle: keep it when it is a
   * scan node, or a Filter / Index Cond of the scan node just kept — what
   * the analyzer needs to judge every scan of a plan the cut would split.
   */
  #evict(line: string): void {
    if (SCAN_NODE.test(line)) {
      this.#middle.push(line);
      this.#middleScanIndent = indentOf(line);
      return;
    }
    if (this.#middleScanIndent < 0) return;
    if (indentOf(line) <= this.#middleScanIndent || CHILD_NODE.test(line)) {
      this.#middleScanIndent = -1;
      return;
    }
    if (SCAN_PROPERTY.test(line)) this.#middle.push(line);
  }

  #orderedTail(): string[] {
    const n = this.#count - HEAD;
    if (n <= 0) return [];
    if (n <= TAIL) return this.#tail.slice(0, n);
    const start = n % TAIL;
    return [...this.#tail.slice(start), ...this.#tail.slice(0, start)];
  }

  #endIndexNode(): void {
    if (this.#inIndex && !this.#indexCond && this.#indexFilter) this.#fullIndex = true;
    this.#inIndex = false;
  }
}

if (import.meta.main) {
  // Usage: bun seqscan-filter.ts [stats-file] < log > kept-plans
  const statsPath = process.argv[2];
  const out = Bun.stdout.writer();
  const filter = new SeqScanFilter((entry) => {
    out.write(`${entry}\n@@END\n`);
    out.flush();
  });
  const decoder = new TextDecoder();
  // The unterminated end of the input so far, in pieces: a line longer than
  // a chunk is joined once, not re-concatenated per chunk.
  let pending: string[] = [];
  let total = 0;
  let nextStat = 0;
  for await (const chunk of Bun.stdin.stream()) {
    total += chunk.byteLength;
    const text = decoder.decode(chunk, { stream: true });
    const lines = text.split("\n");
    if (lines.length === 1) {
      pending.push(text);
      continue;
    }
    pending.push(lines[0] ?? "");
    filter.line(pending.join(""));
    for (let i = 1; i < lines.length - 1; i++) filter.line(lines[i] ?? "");
    pending = [lines[lines.length - 1] ?? ""];
    if (statsPath && total >= nextStat) {
      writeFileSync(statsPath, `${total} bytes of server log read\n`);
      nextStat = total + STATS_EVERY;
    }
  }
  const last = pending.join("");
  if (last !== "") filter.line(last);
  filter.flush();
  await out.end();
  if (statsPath) appendFileSync(statsPath, `${total} bytes of server log read (end)\n`);
}
