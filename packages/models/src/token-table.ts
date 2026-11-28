// SPDX-License-Identifier: MPL-2.0

/**
 * The token table taken out of a catalog graph (#1782).
 *
 * A multilingual embedding model spends most of its weights on one table:
 * a row per token id, looked up by a `Gather` at the graph's start. On
 * Granite 97M that is 180,000 × 384 bytes, 69 of the graph's 97 MB, while a
 * query looks up about twenty rows. ONNX Runtime keeps every initializer of
 * a session in its memory, several times over in its WebAssembly build
 * (about +300 MB for this graph), so the gateway paid for a table it barely
 * reads.
 *
 * {@link splitTokenTable} rewrites the publisher's graph: the `Gather` and
 * its table leave, the gathered rows become a graph input, everything else
 * is copied byte for byte. The table becomes a file of its own, read row by
 * row ({@link TokenTable}). The quantised graphs gather uint8 rows and
 * dequantise them in the next node, so feeding the same rows is the same
 * computation: the split graph answers what the publisher's graph answers
 * (`token-table.test.ts`), and the model keeps its fingerprint.
 *
 * Dependency-free on purpose: the Dockerfiles' `models` stage runs it with
 * nothing installed (fetch.ts derives the files there, and the catalog pins
 * their digests like the publisher's).
 *
 * The protobuf handling is the minimum ONNX's wire format needs: fields
 * are walked, the graph's `node`, `initializer` and `input` fields are
 * rewritten, every other field keeps its exact bytes and order.
 */

import { closeSync, openSync, readSync } from "node:fs";

/** One field of a protobuf message, its encoded bytes kept for a verbatim copy. */
interface WireField {
  readonly num: number;
  readonly wire: number;
  /** Length-delimited payload, or null for a scalar. */
  readonly payload: Uint8Array | null;
  /** Varint value of a scalar field (wire type 0). */
  readonly varint: bigint;
  /** The whole field as encoded: key, length and payload. */
  readonly raw: Uint8Array;
}

/** Walks the fields of one message. */
function readFields(data: Uint8Array): WireField[] {
  const out: WireField[] = [];
  let p = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (p >= data.length) throw new RangeError("onnx: truncated varint");
      const b = data[p++] as number;
      result |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return result;
      shift += 7n;
    }
  };
  while (p < data.length) {
    const start = p;
    const key = Number(varint());
    const num = key >>> 3;
    const wire = key & 7;
    let payload: Uint8Array | null = null;
    let value = 0n;
    if (wire === 0) value = varint();
    else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else if (wire === 2) {
      const length = Number(varint());
      if (p + length > data.length) throw new RangeError("onnx: truncated field");
      payload = data.subarray(p, p + length);
      p += length;
    } else throw new RangeError(`onnx: wire type ${wire} is not supported`);
    if (p > data.length) throw new RangeError("onnx: truncated field");
    out.push({ num, wire, payload, varint: value, raw: data.subarray(start, p) });
  }
  return out;
}

function encodeVarint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

/** A length-delimited field: key, length, payload. */
function lengthField(num: number, payload: Uint8Array): Uint8Array {
  const head = [...encodeVarint((num << 3) | 2), ...encodeVarint(payload.length)];
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

function varintField(num: number, value: number): Uint8Array {
  return Uint8Array.from([...encodeVarint(num << 3), ...encodeVarint(value)]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

function text(field: WireField | undefined): string {
  return field?.payload ? utf8Decoder.decode(field.payload) : "";
}

// Field numbers of onnx.proto (ModelProto, GraphProto, NodeProto, TensorProto, …).
const MODEL_GRAPH = 7;
const GRAPH_NODE = 1;
const GRAPH_INITIALIZER = 5;
const GRAPH_INPUT = 11;
const NODE_INPUT = 1;
const NODE_OUTPUT = 2;
const NODE_NAME = 3;
const NODE_OP_TYPE = 4;
const NODE_ATTRIBUTE = 5;
const NODE_DOMAIN = 7;
const ATTRIBUTE_NAME = 1;
const ATTRIBUTE_INT = 3;
const TENSOR_DIMS = 1;
const TENSOR_DATA_TYPE = 2;
const TENSOR_NAME = 8;
const TENSOR_RAW_DATA = 9;
const TENSOR_DATA_LOCATION = 14;
/** TensorProto.DataType UINT8 and INT8. */
const UINT8 = 2;
const INT8 = 3;

/** What {@link splitTokenTable} produced. */
export interface SplitGraph {
  /** The graph without the table's `Gather` and the table. */
  readonly graph: Uint8Array;
  /** The table's rows, `rows × width` bytes, as the graph stored them. */
  readonly table: Uint8Array;
  readonly rows: number;
  readonly width: number;
  /** The new graph input: the gathered rows, `[batch, tokens, width]`. */
  readonly input: string;
  /** The table's element type: "uint8" or "int8". */
  readonly elementType: "uint8" | "int8";
}

/**
 * Takes the table of the `Gather` named `gatherNode` out of an ONNX model.
 * Refuses anything but a lookup of one 2-D 8-bit initializer by the graph
 * input `input_ids` along axis 0, a table some other node also reads, and
 * a table kept outside the graph.
 */
export function splitTokenTable(model: Uint8Array, gatherNode: string): SplitGraph {
  const modelFields = readFields(model);
  const graphField = modelFields.find((f) => f.num === MODEL_GRAPH);
  if (!graphField?.payload) throw new RangeError("onnx: the model has no graph");
  const graphFields = readFields(graphField.payload);

  const nodes = graphFields
    .filter((f) => f.num === GRAPH_NODE)
    .map((f) => ({ field: f, parts: readFields(f.payload as Uint8Array) }));
  const gather = nodes.find((n) => text(n.parts.find((p) => p.num === NODE_NAME)) === gatherNode);
  if (!gather) throw new RangeError(`onnx: no node named "${gatherNode}"`);
  if (text(gather.parts.find((p) => p.num === NODE_OP_TYPE)) !== "Gather")
    throw new RangeError(`onnx: "${gatherNode}" is not a Gather`);
  if (text(gather.parts.find((p) => p.num === NODE_DOMAIN)) !== "")
    throw new RangeError(`onnx: "${gatherNode}" is not in the default domain`);
  for (const attribute of gather.parts.filter((p) => p.num === NODE_ATTRIBUTE)) {
    const a = readFields(attribute.payload as Uint8Array);
    const name = text(a.find((x) => x.num === ATTRIBUTE_NAME));
    const value = a.find((x) => x.num === ATTRIBUTE_INT)?.varint ?? 0n;
    if (name !== "axis" || value !== 0n)
      throw new RangeError(`onnx: "${gatherNode}" gathers along another axis (${name})`);
  }
  const inputs = gather.parts.filter((p) => p.num === NODE_INPUT).map(text);
  const outputs = gather.parts.filter((p) => p.num === NODE_OUTPUT).map(text);
  const [tableName, indices] = inputs;
  const [output] = outputs;
  if (inputs.length !== 2 || outputs.length !== 1 || !tableName || !output)
    throw new RangeError(`onnx: "${gatherNode}" does not have one table, one index and one output`);
  if (indices !== "input_ids")
    throw new RangeError(`onnx: "${gatherNode}" does not look up the graph input input_ids`);
  for (const n of nodes) {
    if (n === gather) continue;
    if (n.parts.some((p) => p.num === NODE_INPUT && text(p) === tableName))
      throw new RangeError(`onnx: the table ${tableName} has another reader`);
  }

  const initializer = graphFields.find(
    (f) =>
      f.num === GRAPH_INITIALIZER &&
      text(readFields(f.payload as Uint8Array).find((p) => p.num === TENSOR_NAME)) === tableName,
  );
  if (!initializer?.payload)
    throw new RangeError(`onnx: the table ${tableName} is not an initializer`);
  const tensor = readFields(initializer.payload);
  if ((tensor.find((p) => p.num === TENSOR_DATA_LOCATION)?.varint ?? 0n) !== 0n)
    throw new RangeError(`onnx: the table ${tableName} is stored outside the graph`);
  const dataType = Number(tensor.find((p) => p.num === TENSOR_DATA_TYPE)?.varint ?? 0n);
  if (dataType !== UINT8 && dataType !== INT8)
    throw new RangeError(`onnx: the table ${tableName} is not 8-bit (type ${dataType})`);
  const dims: number[] = [];
  for (const d of tensor.filter((p) => p.num === TENSOR_DIMS)) {
    if (d.wire === 0) dims.push(Number(d.varint));
    else {
      // Packed repeated int64.
      let p = 0;
      const b = d.payload as Uint8Array;
      while (p < b.length) {
        let v = 0n;
        let s = 0n;
        for (;;) {
          const x = b[p++] as number;
          v |= BigInt(x & 0x7f) << s;
          if (x < 0x80) break;
          s += 7n;
        }
        dims.push(Number(v));
      }
    }
  }
  const [rows, width] = dims;
  if (dims.length !== 2 || !rows || !width)
    throw new RangeError(`onnx: the table ${tableName} is not two-dimensional`);
  const raw = tensor.find((p) => p.num === TENSOR_RAW_DATA)?.payload;
  if (!raw || raw.length !== rows * width)
    throw new RangeError(
      `onnx: the table ${tableName} has no raw data of ${rows} × ${width} bytes`,
    );

  // The gathered rows as a graph input: ValueInfoProto { name, type: TypeProto {
  // tensor_type { elem_type, shape { dim { dim_param } dim { dim_param } dim { dim_value } } } } }.
  const dim = (field: Uint8Array): Uint8Array => lengthField(1, field);
  const shape = concat([
    dim(lengthField(2, utf8.encode("batch_size"))),
    dim(lengthField(2, utf8.encode("sequence_length"))),
    dim(varintField(1, width)),
  ]);
  const tensorType = concat([varintField(1, dataType), lengthField(2, shape)]);
  const valueInfo = concat([
    lengthField(1, utf8.encode(output)),
    lengthField(2, lengthField(1, tensorType)),
  ]);

  // Copy the graph: drop the Gather and the table, add the input after the
  // last existing input (inputs keep their order, the new one comes last).
  const lastInput = graphFields.reduce((at, f, i) => (f.num === GRAPH_INPUT ? i : at), -1);
  const kept: Uint8Array[] = [];
  graphFields.forEach((f, i) => {
    if (f === gather.field || f === initializer) return;
    kept.push(f.raw);
    if (i === lastInput) kept.push(lengthField(GRAPH_INPUT, valueInfo));
  });
  if (lastInput < 0) kept.push(lengthField(GRAPH_INPUT, valueInfo));
  const graph = concat(kept);
  const rebuilt = modelFields.map((f) =>
    f === graphField ? lengthField(MODEL_GRAPH, graph) : f.raw,
  );
  return {
    graph: concat(rebuilt),
    table: raw.slice(),
    rows,
    width,
    input: output,
    elementType: dataType === UINT8 ? "uint8" : "int8",
  };
}

/**
 * A token table on disk, read one row per token. Nothing of it stays in
 * memory but the rows of the text being embedded; the operating system's
 * page cache keeps the rows queries reach for.
 */
export class TokenTable {
  private fd: number | null;

  constructor(
    path: string,
    readonly rows: number,
    readonly width: number,
  ) {
    this.fd = openSync(path, "r");
  }

  /** The rows of `ids`, one after another (`ids.length × width` bytes). */
  gather(ids: readonly number[]): Uint8Array {
    if (this.fd === null) throw new Error("token table: closed");
    const out = new Uint8Array(ids.length * this.width);
    ids.forEach((id, i) => {
      if (!Number.isInteger(id) || id < 0 || id >= this.rows)
        throw new RangeError(`token table: token id ${id} is outside its ${this.rows} rows`);
      const read = readSync(this.fd as number, out, i * this.width, this.width, id * this.width);
      if (read !== this.width) throw new Error(`token table: row ${id} is short (${read} bytes)`);
    });
    return out;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}
