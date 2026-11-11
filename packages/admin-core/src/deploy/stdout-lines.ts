// SPDX-License-Identifier: MPL-2.0

/**
 * #1271 — a child's stdout as whole lines, each decoded once.
 *
 * The generator streams every served file through its stdout as one JSON
 * line (generator-subprocess.ts), and a few of those lines grow with the
 * site: the render deps were 3.5 MB of base64 at 10k pages. A line's bytes
 * stay the chunks that brought them until its newline arrives, then they are
 * decoded in one go. So:
 *   - a long line costs its bytes, not a copy per chunk (appending each chunk
 *     to one string and searching it from the start did);
 *   - nothing of a line outlives the handler it was given to (the rest of
 *     such a string kept the whole line alive, and Bun's `node:readline`
 *     keeps the last line it emitted);
 *   - a character split across two chunks is decoded whole, not as two
 *     replacement characters.
 */

const NEWLINE = 0x0a;

/** Splits a byte stream into lines; see the module comment. */
export class LineSplitter {
  /** The bytes of the line that has not ended yet. */
  #parts: Buffer[] = [];

  /**
   * Take one chunk of the stream. `onLine` gets every line the chunk ends,
   * in order and without its newline; a line the stream never ends is not
   * handed on.
   */
  push(chunk: Buffer, onLine: (line: string) => void): void {
    let start = 0;
    let newline = chunk.indexOf(NEWLINE);
    while (newline !== -1) {
      const tail = chunk.subarray(start, newline);
      const bytes = this.#parts.length === 0 ? tail : Buffer.concat([...this.#parts, tail]);
      this.#parts = [];
      onLine(bytes.toString("utf8"));
      start = newline + 1;
      newline = chunk.indexOf(NEWLINE, start);
    }
    if (start < chunk.length) this.#parts.push(start === 0 ? chunk : chunk.subarray(start));
  }
}
