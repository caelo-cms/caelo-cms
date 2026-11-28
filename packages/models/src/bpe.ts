// SPDX-License-Identifier: MPL-2.0

/**
 * A compact byte-level BPE tokenizer (#1782).
 *
 * Hugging Face's JavaScript tokenizer keeps a 180,000-token vocabulary and
 * 413,540 merges of Granite 97M as maps of strings: 138 MB of the gateway's
 * memory, more than the graph itself once its token table is split off
 * (token-table.ts). This one holds the same data in typed arrays, about
 * 20 MB, read from a file derived from `tokenizer.json` at fetch time
 * ({@link deriveTokenizer}) and pinned in the catalog like every model file.
 *
 * It cuts text exactly as `@huggingface/tokenizers` does, because the
 * index's passage vectors were embedded with that library's ids:
 *
 * - added tokens are split out first, at each position the longest one
 *   that starts there (the library's `DictionarySplitter`; it does not
 *   apply `single_word`, so neither does this);
 * - the rest is cut by the pre-tokenizer's split pattern (the library's
 *   JavaScript translation of the Rust regex, pinned in the derived file),
 *   gaps included;
 * - each piece becomes its UTF-8 bytes; a piece the vocabulary holds whole
 *   is one token (`ignore_merges`), otherwise its bytes merge pair by pair,
 *   lowest merge rank first, leftmost first among equal ranks;
 * - a token the vocabulary lacks (a control byte without a token of its
 *   own) is dropped, as the library drops it without an unknown token;
 * - the template's special tokens go around the text.
 *
 * `bpe.test.ts` checks the ids against the library on a large mixed corpus.
 */

/** Magic and version of the derived file. */
const MAGIC = 0x4b4f5443; // "CTOK"
const VERSION = 1;

/** GPT-2's byte-level alphabet: each byte as the character byte-level vocabularies spell it with. */
function byteToChar(): readonly string[] {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const out = new Array<string>(256);
  bs.forEach((b, i) => {
    out[b] = String.fromCharCode(cs[i] as number);
  });
  return out;
}

/** GPT-2's byte-level alphabet, by byte. */
export const BYTE_ALPHABET: readonly string[] = byteToChar();

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

class Writer {
  private chunks: Uint8Array[] = [];
  private size = 0;
  u32(n: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.push(b);
  }
  bytes(b: Uint8Array): void {
    this.u32(b.length);
    this.push(b);
  }
  u32s(values: Uint32Array): void {
    this.u32(values.length);
    this.push(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  }
  private push(b: Uint8Array): void {
    this.chunks.push(b);
    this.size += b.length;
  }
  finish(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

class Reader {
  private at = 0;
  private readonly view: DataView;
  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  u32(): number {
    if (this.at + 4 > this.data.length) throw new RangeError("tokenizer file: truncated");
    const n = this.view.getUint32(this.at, true);
    this.at += 4;
    return n;
  }
  bytes(): Uint8Array {
    const n = this.u32();
    if (this.at + n > this.data.length) throw new RangeError("tokenizer file: truncated");
    const out = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u32s(): Uint32Array {
    const n = this.u32();
    if (this.at + n * 4 > this.data.length) throw new RangeError("tokenizer file: truncated");
    // A copy: aligned, and independent of the file's buffer.
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.view.getUint32(this.at + i * 4, true);
    this.at += n * 4;
    return out;
  }
  get done(): boolean {
    return this.at === this.data.length;
  }
}

/** The pre-tokenizer's split pattern as JavaScript runs it. */
export interface SplitPattern {
  readonly source: string;
  readonly flags: string;
}

function fail(what: string): never {
  throw new RangeError(
    `tokenizer.json: ${what}; only byte-level BPE in the shape the catalog's models use is supported`,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("an object was expected");
  return value as Record<string, unknown>;
}

/**
 * Derives the compact tokenizer file from a model's `tokenizer.json`.
 * Refuses any part of the pipeline it would not reproduce exactly
 * (a normaliser, another pre-tokenizer, stripping added tokens, …).
 * `pattern` is the split pattern in its JavaScript form.
 */
export function deriveTokenizer(json: unknown, pattern: SplitPattern): Uint8Array {
  const j = record(json);
  if (j.normalizer !== null) fail("a normalizer is set");
  const model = record(j.model);
  if (model.type !== "BPE") fail("the model is not BPE");
  if (model.dropout !== null && model.dropout !== undefined) fail("BPE dropout is set");
  if (model.unk_token !== null && model.unk_token !== undefined) fail("an unknown token is set");
  if (model.byte_fallback === true) fail("byte fallback is set");
  if (model.continuing_subword_prefix || model.end_of_word_suffix) fail("subword affixes are set");
  if (model.ignore_merges !== true) fail("ignore_merges is not set");
  const pre = record(j.pre_tokenizer);
  const steps = pre.type === "Sequence" ? (pre.pretokenizers as unknown[]) : null;
  const split = steps ? record(steps[0]) : null;
  const byteLevel = steps ? record(steps[1]) : null;
  if (
    !steps ||
    steps.length !== 2 ||
    split?.type !== "Split" ||
    split.behavior !== "Isolated" ||
    split.invert !== false ||
    byteLevel?.type !== "ByteLevel" ||
    byteLevel.add_prefix_space !== false ||
    byteLevel.use_regex !== false
  )
    fail("the pre-tokenizer is not Split (isolated) then ByteLevel without its own regex");
  const post = record(j.post_processor);
  if (post.type !== "TemplateProcessing") fail("the post-processor is not a template");
  const specials = record(post.special_tokens);
  const prefix: number[] = [];
  const suffix: number[] = [];
  let seenSequence = false;
  for (const item of post.single as unknown[]) {
    const it = record(item);
    if (it.Sequence) {
      if (seenSequence) fail("the template holds the text twice");
      seenSequence = true;
      continue;
    }
    const special = record(it.SpecialToken);
    const ids = record(specials[special.id as string]).ids as number[];
    (seenSequence ? suffix : prefix).push(...ids);
  }
  if (!seenSequence) fail("the template does not hold the text");

  const charToByte = new Map(BYTE_ALPHABET.map((c, b) => [c, b]));
  const vocab = record(model.vocab) as Record<string, number>;
  const size = Object.keys(vocab).length;
  const tokens: (Uint8Array | null)[] = new Array(size).fill(null);
  for (const [token, id] of Object.entries(vocab)) {
    if (!Number.isInteger(id) || id < 0 || id >= size) fail(`vocabulary id ${id} is out of range`);
    const bytes: number[] = [];
    let reachable = true;
    for (const c of token) {
      const b = charToByte.get(c);
      if (b === undefined) reachable = false;
      else bytes.push(b);
    }
    // A token spelled outside the byte alphabet can never come out of the bytes of a text.
    tokens[id] = reachable ? Uint8Array.from(bytes) : new Uint8Array(0);
  }
  if (tokens.some((t) => t === null)) fail("the vocabulary ids are not contiguous");
  const merges = model.merges as unknown[];
  const triples = new Uint32Array(merges.length * 3);
  merges.forEach((m, i) => {
    const [a, b] = Array.isArray(m) ? (m as string[]) : String(m).split(" ", 2);
    const left = vocab[a as string];
    const right = vocab[b as string];
    const merged = vocab[`${a}${b}`];
    if (left === undefined || right === undefined || merged === undefined)
      fail(`merge ${i} names a token outside the vocabulary`);
    triples[i * 3] = left;
    triples[i * 3 + 1] = right;
    triples[i * 3 + 2] = merged;
  });
  const added = (j.added_tokens as unknown[]).map((t) => {
    const token = record(t);
    if (token.lstrip === true || token.rstrip === true) fail("an added token strips spaces");
    if (token.normalized === true) fail("an added token is normalized");
    return { id: token.id as number, content: token.content as string };
  });

  const w = new Writer();
  w.u32(MAGIC);
  w.u32(VERSION);
  const offsets = new Uint32Array(size + 1);
  let at = 0;
  tokens.forEach((t, i) => {
    offsets[i] = at;
    at += (t as Uint8Array).length;
  });
  offsets[size] = at;
  const blob = new Uint8Array(at);
  tokens.forEach((t, i) => {
    blob.set(t as Uint8Array, offsets[i] as number);
  });
  w.u32s(offsets);
  w.bytes(blob);
  w.u32s(triples);
  w.u32(added.length);
  for (const a of added) {
    w.u32(a.id);
    w.bytes(utf8.encode(a.content));
  }
  w.u32s(Uint32Array.from(prefix));
  w.u32s(Uint32Array.from(suffix));
  w.bytes(utf8.encode(pattern.source));
  w.bytes(utf8.encode(pattern.flags));
  return w.finish();
}

/** FNV-1a over a byte range. */
function hashBytes(data: Uint8Array, start: number, end: number): number {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i++) h = Math.imul(h ^ (data[i] as number), 0x01000193);
  return h >>> 0;
}

function hashPair(left: number, right: number): number {
  let h = Math.imul(left, 0x9e3779b1) ^ right;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

/** A tokenizer read from a derived file. */
export class CompactTokenizer {
  private readonly offsets: Uint32Array;
  private readonly blob: Uint8Array;
  /** Vocabulary lookup by bytes: open addressing over token ids (-1 empty). */
  private readonly vocabSlots: Int32Array;
  /** Merge lookup by pair: left, right, merged id and rank per slot (rank -1 empty). */
  private readonly mergeLeft: Int32Array;
  private readonly mergeRight: Int32Array;
  private readonly mergeId: Int32Array;
  private readonly mergeRank: Int32Array;
  private readonly byteToken: Int32Array;
  private readonly added: ReadonlyMap<string, readonly { content: string; id: number }[]>;
  private readonly prefix: readonly number[];
  private readonly suffix: readonly number[];
  private readonly pattern: RegExp;

  constructor(file: Uint8Array) {
    const r = new Reader(file);
    if (r.u32() !== MAGIC || r.u32() !== VERSION)
      throw new RangeError("tokenizer file: not a compact tokenizer of this version");
    this.offsets = r.u32s();
    this.blob = r.bytes().slice();
    const triples = r.u32s();
    const addedCount = r.u32();
    const added = new Map<string, { content: string; id: number }[]>();
    for (let i = 0; i < addedCount; i++) {
      const id = r.u32();
      const content = utf8Decoder.decode(r.bytes());
      if (content.length === 0) continue;
      const first = content[0] as string;
      (added.get(first) ?? added.set(first, []).get(first))?.push({ content, id });
    }
    // Longest first: the first one that matches at a position is the longest there.
    for (const list of added.values()) list.sort((a, b) => b.content.length - a.content.length);
    this.added = added;
    this.prefix = [...r.u32s()];
    this.suffix = [...r.u32s()];
    this.pattern = new RegExp(utf8Decoder.decode(r.bytes()), utf8Decoder.decode(r.bytes()));
    if (!r.done) throw new RangeError("tokenizer file: trailing bytes");

    const size = this.offsets.length - 1;
    const vocabCapacity = 1 << Math.ceil(Math.log2(size * 2));
    this.vocabSlots = new Int32Array(vocabCapacity).fill(-1);
    for (let id = 0; id < size; id++) {
      const start = this.offsets[id] as number;
      const end = this.offsets[id + 1] as number;
      if (end === start) continue;
      let slot = hashBytes(this.blob, start, end) & (vocabCapacity - 1);
      while ((this.vocabSlots[slot] as number) >= 0) slot = (slot + 1) & (vocabCapacity - 1);
      this.vocabSlots[slot] = id;
    }
    this.byteToken = new Int32Array(256).fill(-1);
    for (let b = 0; b < 256; b++) this.byteToken[b] = this.lookup(Uint8Array.of(b), 0, 1);

    const merges = triples.length / 3;
    const mergeCapacity = 1 << Math.ceil(Math.log2(merges * 2));
    this.mergeLeft = new Int32Array(mergeCapacity);
    this.mergeRight = new Int32Array(mergeCapacity);
    this.mergeId = new Int32Array(mergeCapacity);
    this.mergeRank = new Int32Array(mergeCapacity).fill(-1);
    for (let rank = 0; rank < merges; rank++) {
      const left = triples[rank * 3] as number;
      const right = triples[rank * 3 + 1] as number;
      let slot = hashPair(left, right) & (mergeCapacity - 1);
      let duplicate = false;
      while ((this.mergeRank[slot] as number) >= 0) {
        if (this.mergeLeft[slot] === left && this.mergeRight[slot] === right) {
          duplicate = true;
          break;
        }
        slot = (slot + 1) & (mergeCapacity - 1);
      }
      // A pair listed twice keeps its first (lowest) rank, as a map keyed by the pair would.
      if (duplicate) continue;
      this.mergeLeft[slot] = left;
      this.mergeRight[slot] = right;
      this.mergeId[slot] = triples[rank * 3 + 2] as number;
      this.mergeRank[slot] = rank;
    }
  }

  /** The token id of `data[start, end)`, or -1. */
  private lookup(data: Uint8Array, start: number, end: number): number {
    const capacity = this.vocabSlots.length;
    const length = end - start;
    let slot = hashBytes(data, start, end) & (capacity - 1);
    for (;;) {
      const id = this.vocabSlots[slot] as number;
      if (id < 0) return -1;
      const s = this.offsets[id] as number;
      if ((this.offsets[id + 1] as number) - s === length) {
        let same = true;
        for (let i = 0; i < length; i++)
          if (this.blob[s + i] !== data[start + i]) {
            same = false;
            break;
          }
        if (same) return id;
      }
      slot = (slot + 1) & (capacity - 1);
    }
  }

  /** The merge slot of a pair, or -1. */
  private merge(left: number, right: number): number {
    if (left < 0 || right < 0) return -1;
    const capacity = this.mergeRank.length;
    let slot = hashPair(left, right) & (capacity - 1);
    for (;;) {
      if ((this.mergeRank[slot] as number) < 0) return -1;
      if (this.mergeLeft[slot] === left && this.mergeRight[slot] === right) return slot;
      slot = (slot + 1) & (capacity - 1);
    }
  }

  /** Token ids of one piece's bytes, appended to `out`. */
  private bpe(bytes: Uint8Array, out: number[]): void {
    const n = bytes.length;
    if (n === 0) return;
    const whole = this.lookup(bytes, 0, n);
    if (whole >= 0) {
      out.push(whole);
      return;
    }
    const sym = new Int32Array(n);
    const next = new Int32Array(n);
    const prev = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      sym[i] = this.byteToken[bytes[i] as number] as number;
      next[i] = i + 1 < n ? i + 1 : -1;
      prev[i] = i - 1;
    }
    // A heap of candidate merges keyed rank * 2^22 + left position (exact in a double).
    const heap: number[] = [];
    const push = (pos: number): void => {
      const right = next[pos] as number;
      if (right < 0) return;
      const slot = this.merge(sym[pos] as number, sym[right] as number);
      if (slot < 0) return;
      const key = (this.mergeRank[slot] as number) * 4_194_304 + pos;
      heap.push(key);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if ((heap[p] as number) <= key) break;
        heap[i] = heap[p] as number;
        i = p;
      }
      heap[i] = key;
    };
    const pop = (): number => {
      const top = heap[0] as number;
      const last = heap.pop() as number;
      if (heap.length > 0) {
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          if (l >= heap.length) break;
          const r = l + 1;
          const c = r < heap.length && (heap[r] as number) < (heap[l] as number) ? r : l;
          if ((heap[c] as number) >= last) break;
          heap[i] = heap[c] as number;
          i = c;
        }
        heap[i] = last;
      }
      return top;
    };
    if (n > 4_194_304) throw new RangeError("tokenizer: a piece longer than 4 MiB");
    for (let i = 0; i + 1 < n; i++) push(i);
    while (heap.length > 0) {
      const key = pop();
      const pos = key % 4_194_304;
      const rank = (key - pos) / 4_194_304;
      const right = next[pos] as number;
      // A stale candidate: the pair at `pos` changed since it was pushed.
      if (right < 0 || sym[pos] === -2) continue;
      const slot = this.merge(sym[pos] as number, sym[right] as number);
      if (slot < 0 || this.mergeRank[slot] !== rank) continue;
      sym[pos] = this.mergeId[slot] as number;
      const after = next[right] as number;
      next[pos] = after;
      if (after >= 0) prev[after] = pos;
      sym[right] = -2;
      const before = prev[pos] as number;
      if (before >= 0) push(before);
      push(pos);
    }
    for (let i = 0; i >= 0; i = next[i] as number) {
      const id = sym[i] as number;
      if (id >= 0) out.push(id);
    }
  }

  /** The text's token ids, the template's special tokens around them. */
  encode(text: string): number[] {
    const out: number[] = [...this.prefix];
    let start = 0;
    let i = 0;
    const plain = (end: number): void => {
      if (end <= start) return;
      const section = text.slice(start, end);
      let last = 0;
      for (const m of section.matchAll(this.pattern)) {
        if (last < m.index) this.bpe(utf8.encode(section.slice(last, m.index)), out);
        if (m[0].length > 0) this.bpe(utf8.encode(m[0]), out);
        last = m.index + m[0].length;
      }
      if (last < section.length) this.bpe(utf8.encode(section.slice(last)), out);
    };
    while (i < text.length) {
      const candidates = this.added.get(text[i] as string);
      const hit = candidates?.find((c) => text.startsWith(c.content, i));
      if (hit) {
        plain(i);
        out.push(hit.id);
        i += hit.content.length;
        start = i;
      } else i++;
    }
    plain(text.length);
    out.push(...this.suffix);
    return out;
  }
}
