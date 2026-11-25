// SPDX-License-Identifier: MPL-2.0

/**
 * A catalog model's tokenizer (#1650): Hugging Face's pure-JS
 * `@huggingface/tokenizers`, so the gateway runs no native code on a
 * visitor's text. `tokenize.test.ts` holds token ids the reference (Rust)
 * implementation produced for German and English edge cases; both must
 * agree, or index and query would be cut into different tokens.
 */

import type { EmbeddingModel } from "@caelo-cms/shared";
import { Tokenizer } from "@huggingface/tokenizers";

/** A text as the graph takes it. */
export interface Encoded {
  readonly ids: readonly number[];
}

/** Tokenizes a model's texts; long texts are cut to the model's `maxTokens`. */
export class ModelTokenizer {
  private readonly tokenizer: Tokenizer;

  constructor(
    private readonly model: EmbeddingModel,
    tokenizerJson: unknown,
  ) {
    this.tokenizer = new Tokenizer(tokenizerJson as object, {});
  }

  /**
   * Token ids of `text` with the model's prefix and special tokens. A text
   * longer than `maxTokens` keeps its start and the closing special token:
   * a section's heading and first sentences carry its topic.
   */
  encode(text: string, kind: "query" | "passage"): Encoded {
    const ids = this.tokenizer.encode(this.model.prefixes[kind] + text).ids;
    const max = this.model.maxTokens;
    if (ids.length <= max) return { ids };
    return { ids: [...ids.slice(0, max - 1), ids[ids.length - 1] as number] };
  }
}
