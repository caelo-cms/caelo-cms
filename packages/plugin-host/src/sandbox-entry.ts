// SPDX-License-Identifier: MPL-2.0

/**
 * Trusted bootstrap for the Deno sandbox child, bundled together with the
 * validated plugin source (see `buildIsolatedBundle`).
 *
 * Ordering is the invariant here. ES module `import` declarations are
 * hoisted, and a module's dependencies are evaluated — in source order —
 * before the module's own body. So anything the bootstrap does in the entry
 * body runs AFTER the plugin's top-level code. Capturing primordials or
 * removing `Deno` in the entry body would let a plugin's top-level
 * `JSON.stringify = …` or `const w = globalThis.Deno.stdout` win the race.
 *
 * Hence two modules: `caelo:prelude` captures every global the protocol
 * relies on, silences `console`, and removes the `Deno` namespace; the entry
 * imports it BEFORE `caelo:plugin`, so the prelude has finished before one
 * line of plugin code runs. `sandbox-runtime.test.ts` pins this order with
 * real Deno executions.
 *
 * What the prelude protects: the bootstrap's own correctness against plugin
 * tampering, and the plugin's access to the raw protocol channel. It is not
 * the permission boundary — Deno's `--deny-*` flags and the host-side broker
 * (which authorizes and validates every call, sequence number and size)
 * are, and they hold whatever the child does.
 */
export const sandboxPreludeSource = `
const DenoNs = globalThis.Deno;
const FunctionCall = Function.prototype.call;
const uncurry = (fn) => FunctionCall.bind(fn);
export const JSONParse = JSON.parse;
export const JSONStringify = JSON.stringify;
export const ObjectFreeze = Object.freeze;
export const ObjectHasOwn = Object.hasOwn;
export const NumberIsFinite = Number.isFinite;
export const PromiseCtor = Promise;
export const PromiseThen = uncurry(Promise.prototype.then);
export const StringCtor = String;
export const ErrorCtor = Error;
export const MapCtor = Map;
export const MapGet = uncurry(Map.prototype.get);
export const MapSet = uncurry(Map.prototype.set);
export const MapDelete = uncurry(Map.prototype.delete);
export const MapSize = uncurry(Object.getOwnPropertyDescriptor(Map.prototype, "size").get);
export const ArrayIncludes = uncurry(Array.prototype.includes);
export const StringIndexOf = uncurry(String.prototype.indexOf);
export const StringSlice = uncurry(String.prototype.slice);
export const StringEndsWith = uncurry(String.prototype.endsWith);
export const Uint8Subarray = uncurry(Uint8Array.prototype.subarray);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = uncurry(TextEncoder.prototype.encode);
const decode = uncurry(TextDecoder.prototype.decode);
export const encodeText = (text) => encode(encoder, text);
export const decodeChunk = (chunk) => decode(decoder, chunk, { stream: true });
export const stdoutWriteSync = DenoNs.stdout.writeSync.bind(DenoNs.stdout);
const stdinReader = DenoNs.stdin.readable.getReader();
const readerRead = uncurry(ReadableStreamDefaultReader.prototype.read);
export const readStdin = () => readerRead(stdinReader);
// Deno's console writes straight to stdout: plugin logging (top-level
// included) would corrupt the protocol or fill a host-side buffer.
console.log = console.info = console.debug = console.warn = console.error = () => {};
delete globalThis.Deno;
// Fail closed: a runtime that refuses the delete must not run plugin code.
if (typeof globalThis.Deno !== "undefined") throw new Error("SandboxPreludeFailed: Deno namespace still reachable");
`;

/** Entry module: prelude first, then the plugin, then the protocol loop. */
export const sandboxEntrySource = `
import {
  ArrayIncludes, ErrorCtor, JSONParse, JSONStringify, MapCtor, MapDelete, MapGet, MapSet,
  MapSize, NumberIsFinite, ObjectFreeze, ObjectHasOwn, PromiseCtor, PromiseThen,
  StringCtor, StringEndsWith, StringIndexOf, StringSlice, Uint8Subarray, decodeChunk, encodeText,
  readStdin, stdoutWriteSync,
} from "caelo:prelude";
import plugin from "caelo:plugin";
const NON_JSON_TYPES = ["function", "symbol", "bigint"];
const write = (value, strictCas = false) => {
  // Losing a field or converting NaN to null would change a CAS predicate.
  // Validate during serialization, before anything reaches the host.
  const json = JSONStringify(value, strictCas ? (_key, item) => {
    if (item === undefined || ArrayIncludes(NON_JSON_TYPES, typeof item)
      || (typeof item === "number" && !NumberIsFinite(item)))
      throw new ErrorCtor("compareAndSwap requires JSON values; undefined and non-finite values are forbidden");
    return item;
  } : undefined);
  const bytes = encodeText(json + "\\n");
  if (bytes.length > 1048576) throw new ErrorCtor("SandboxMessageTooLarge");
  let offset = 0;
  while (offset < bytes.length) offset += stdoutWriteSync(Uint8Subarray(bytes, offset));
};
const pending = new MapCtor();
let nextId = 0;
const rpc = (method, ...args) => new PromiseCtor((resolve, reject) => {
  if (nextId >= 1024) return reject(new ErrorCtor("SandboxCallLimit"));
  const id = nextId;
  MapSet(pending, id, { resolve, reject });
  // A refused call consumes no sequence number and leaves nothing pending,
  // so the plugin can catch the error and keep going.
  try {
    write({ kind: "call", id, method, args }, StringEndsWith(method, ".compareAndSwap"));
    nextId++;
  } catch (error) {
    MapDelete(pending, id);
    reject(error);
  }
});
const handles = (prefix, names) => {
  const out = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    out[name] = (...args) => rpc(prefix + "." + name, ...args);
  }
  return ObjectFreeze(out);
};
const QUERY_METHODS = ["insert", "list", "update", "compareAndSwap", "delete"];
let initialized = false;
let buffer = "";
const execute = async (message) => {
  const ctx = ObjectFreeze({
    query: handles("query", QUERY_METHODS),
    ...(message.hasAdminQuery ? { adminQuery: handles("adminQuery", QUERY_METHODS) } : {}),
    ...(message.hasImages ? { images: handles("images", ["describe", "get", "generate", "edit", "transform"]) } : {}),
    ...(message.hasFonts ? { fonts: handles("fonts", ["find", "inspect", "resolve", "readChunk"]) } : {}),
    ...(message.hasSiteMedia ? { siteMedia: handles("siteMedia", ["find", "inspect", "readChunk"]) } : {}),
    ...(message.hasPrivateFiles ? { privateFiles: handles("privateFiles", ["begin", "writeChunk", "commit", "stat", "readChunk", "remove"]) } : {}),
    api: handles("api", ["list", "get"]),
    captcha: handles("captcha", ["requireProof"]),
    theme: ObjectFreeze(message.theme), visitor: ObjectFreeze(message.visitor),
    invocation: ObjectFreeze(message.invocation),
  });
  if (!plugin || plugin.slug !== message.slug || plugin.version !== message.version || plugin.tier !== 2)
    throw new ErrorCtor("SandboxDefinitionMismatch");
  if (message.operation === "$inspect") {
    const names = message.args.operations;
    for (let i = 0; i < names.length; i++)
      if (typeof plugin.operations?.[names[i]] !== "function") throw new ErrorCtor("SandboxOperationNotDeclared: " + names[i]);
    if (message.args.hasStaticRender && typeof plugin.staticRender !== "function") throw new ErrorCtor("SandboxStaticRenderMissing");
    write({ kind: "result", value: true });
    return;
  }
  let handler;
  if (message.operation === "$staticRender") handler = plugin.staticRender;
  else handler = ObjectHasOwn(plugin.operations, message.operation) && plugin.operations[message.operation];
  if (typeof handler !== "function") throw new ErrorCtor("SandboxOperationNotDeclared");
  const value = await handler(ctx, message.args);
  if (MapSize(pending)) throw new ErrorCtor("SandboxUnawaitedCall");
  write({ kind: "result", value: value === undefined ? null : value });
};
for (;;) {
  const { done, value: chunk } = await readStdin();
  if (done) break;
  buffer += decodeChunk(chunk);
  if (buffer.length > 1048576) throw new ErrorCtor("SandboxMessageTooLarge");
  let end;
  while ((end = StringIndexOf(buffer, "\\n")) >= 0) {
    const message = JSONParse(StringSlice(buffer, 0, end));
    buffer = StringSlice(buffer, end + 1);
    if (!initialized) {
      initialized = true;
      PromiseThen(execute(message), undefined, (error) =>
        write({ kind: "error", message: StringSlice(StringCtor(error?.message ?? error), 0, 4000) }));
    } else {
      const call = MapGet(pending, message.id);
      if (!call) throw new ErrorCtor("SandboxUnexpectedResponse");
      MapDelete(pending, message.id);
      if (message.ok) call.resolve(message.value);
      else call.reject(new ErrorCtor(message.message));
    }
  }
}
`;
