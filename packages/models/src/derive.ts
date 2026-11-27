// SPDX-License-Identifier: MPL-2.0

/**
 * The files a process loads, derived from a catalog model's pinned files
 * (#1782): the graph without its token table, the table, and the compact
 * tokenizer (`EmbeddingDerivedFiles` in the catalog says what each is).
 * fetch.ts runs this once per model at image build and in a checkout; the
 * results must match the catalog's pins byte for byte, so a derivation
 * that changed (another graph, a bug here) fails loudly instead of
 * shipping files nobody reviewed.
 *
 * Dependency-free like fetch.ts: the Dockerfiles' `models` stage runs it.
 */

import type { EmbeddingDerivedFile, EmbeddingModel } from "@caelo-cms/shared";
import { deriveTokenizer } from "./bpe.js";
import { ModelFileError, sha256Hex } from "./files.js";
import { splitTokenTable } from "./token-table.js";

/** The derived files' bytes. */
export interface DerivedBytes {
  readonly graph: Uint8Array;
  readonly table: Uint8Array;
  readonly tokenizer: Uint8Array;
}

function pinned(model: EmbeddingModel, pin: EmbeddingDerivedFile, data: Uint8Array): void {
  const digest = sha256Hex(data);
  if (data.length !== pin.bytes || digest !== pin.sha256) {
    throw new ModelFileError(
      `embedding model ${model.id}: the derived ${pin.name} has ${data.length} bytes with SHA-256 ${digest}, the catalog pins ${pin.bytes} bytes with ${pin.sha256}`,
    );
  }
}

/**
 * Derives a model's files from its verified graph and tokenizer and checks
 * them against the catalog. Throws a {@link ModelFileError} on any
 * difference.
 */
export function deriveModelFiles(
  model: EmbeddingModel,
  graph: Uint8Array,
  tokenizerJson: unknown,
): DerivedBytes {
  const d = model.derived;
  const split = splitTokenTable(graph, d.gather);
  if (
    split.input !== d.tableInput ||
    split.rows !== d.rows ||
    split.width !== d.width ||
    split.elementType !== d.elementType
  ) {
    throw new ModelFileError(
      `embedding model ${model.id}: the token table is ${split.rows} × ${split.width} ${split.elementType} read as ${split.input}, the catalog says ${d.rows} × ${d.width} ${d.elementType} read as ${d.tableInput}`,
    );
  }
  const tokenizer = deriveTokenizer(tokenizerJson, d.splitPattern);
  pinned(model, d.graph, split.graph);
  pinned(model, d.table, split.table);
  pinned(model, d.tokenizer, tokenizer);
  return { graph: split.graph, table: split.table, tokenizer };
}
