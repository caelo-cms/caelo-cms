// SPDX-License-Identifier: MPL-2.0

/**
 * A catalog model's tokenizer (#1650, #1782): the compact byte-level BPE of
 * bpe.ts, read from the model's derived `tokenizer.bin`. It is JavaScript,
 * so the gateway runs no native code on a visitor's text, and it cuts text
 * exactly like `@huggingface/tokenizers` with the publisher's
 * `tokenizer.json` (`bpe.test.ts`), which in turn agrees with the Rust
 * reference (`model.test.ts`): index and query are cut into the same tokens.
 */

import type { EmbeddingModel } from "@caelo-cms/shared";
import { CompactTokenizer } from "./bpe.js";

/** A text as the graph takes it. */
export interface Encoded {
  readonly ids: readonly number[];
}

/** Tokenizes a model's texts; long texts are cut to the model's `maxTokens`. */
export class ModelTokenizer {
  private readonly tokenizer: CompactTokenizer;

  constructor(
    private readonly model: EmbeddingModel,
    tokenizerFile: Uint8Array,
  ) {
    this.tokenizer = new CompactTokenizer(tokenizerFile);
  }

  /**
   * Token ids of `text` with the model's prefix and special tokens. A text
   * longer than `maxTokens` keeps its start and the closing special token:
   * a section's heading and first sentences carry its topic.
   */
  encode(text: string, kind: "query" | "passage"): Encoded {
    const ids = this.tokenizer.encode(this.model.prefixes[kind] + text);
    const max = this.model.maxTokens;
    if (ids.length <= max) return { ids };
    return { ids: [...ids.slice(0, max - 1), ids[ids.length - 1] as number] };
  }
}
