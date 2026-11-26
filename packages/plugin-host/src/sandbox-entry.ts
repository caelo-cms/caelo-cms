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
// Node's \`process\` is Deno's compatibility layer over the namespace just
// removed: touching it would reach back for \`Deno\` (newer Deno throws
// there asynchronously and takes the child down). A plugin reads no
// environment, argv or exit code anyway, so it goes too.
delete globalThis.process;
// Fail closed: a runtime that refuses a delete must not run plugin code.
if (typeof globalThis.Deno !== "undefined") throw new Error("SandboxPreludeFailed: Deno namespace still reachable");
if (typeof globalThis.process !== "undefined") throw new Error("SandboxPreludeFailed: process still reachable");
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
      throw new ErrorCtor("a compareAndSwap or upsert call requires JSON values; undefined and non-finite values are forbidden");
    return item;
  } : undefined);
  const bytes = encodeText(json + "\\n");
  if (bytes.length > 1048576) throw new ErrorCtor("SandboxMessageTooLarge");
  let offset = 0;
  while (offset < bytes.length) offset += stdoutWriteSync(Uint8Subarray(bytes, offset));
};
const pending = new MapCtor();
let nextId = 0;
let callLimit = 1024;
const rpc = (method, ...args) => new PromiseCtor((resolve, reject) => {
  if (nextId >= callLimit) return reject(new ErrorCtor("SandboxCallLimit"));
  const id = nextId;
  MapSet(pending, id, { resolve, reject });
  // A refused call consumes no sequence number and leaves nothing pending,
  // so the plugin can catch the error and keep going.
  try {
    // An upsert's key names its row: a value JSON would drop or turn into
    // null names another row, so it is checked like a compare-and-swap.
    write({ kind: "call", id, method, args }, StringEndsWith(method, ".compareAndSwap") || method === "adminQuery.upsert");
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
const QUERY_METHODS = ["insert", "list", "update", "updateMany", "compareAndSwap", "delete"];
// #1659 — upsert is private storage only. Its call is checked like a
// compare-and-swap (no undefined), so options left out stay out of the call.
const adminQueryHandle = () => {
  const out = {};
  for (let i = 0; i < QUERY_METHODS.length; i++) {
    const name = QUERY_METHODS[i];
    out[name] = (...args) => rpc("adminQuery." + name, ...args);
  }
  out.upsert = (table, key, values, options) => options === undefined
    ? rpc("adminQuery.upsert", table, key, values)
    : rpc("adminQuery.upsert", table, key, values, options);
  return ObjectFreeze(out);
};
// Epic #1644 — config.entities answers entry pairs (JSON has no Map), and
// takes any number of ids, as the SDK promises: the broker reads 1000 per call.
const CONFIG_ENTITY_CHUNK = 1000;
const configHandle = () => ObjectFreeze({
  get: () => rpc("config.get"),
  entity: (kind, id) => rpc("config.entity", kind, id),
  entities: async (kind, ids) => {
    const out = new MapCtor();
    for (let i = 0; i < ids.length; i += CONFIG_ENTITY_CHUNK) {
      for (const [id, values] of await rpc("config.entities", kind, ids.slice(i, i + CONFIG_ENTITY_CHUNK))) out.set(id, values);
    }
    return out;
  },
  configured: (kind) => rpc("config.configured", kind),
});
// A batch of documents travels in messages below the 1 MB line limit: the
// bootstrap splits it, so a plugin need not know the wire's size.
const UPSERT_CHUNK_BYTES = 768 * 1024;
const collectionHandle = (name) => ObjectFreeze({
  upsert: async (docs) => {
    let chunk = [];
    let bytes = 0;
    for (let i = 0; i < docs.length; i++) {
      const size = encodeText(JSONStringify(docs[i])).length + 1;
      if (chunk.length > 0 && (bytes + size > UPSERT_CHUNK_BYTES || chunk.length === 500)) {
        await rpc("collections.upsert", name, chunk);
        chunk = [];
        bytes = 0;
      }
      chunk[chunk.length] = docs[i];
      bytes += size;
    }
    if (chunk.length > 0) await rpc("collections.upsert", name, chunk);
  },
  delete: async (ids) => {
    for (let i = 0; i < ids.length; i += 1000) await rpc("collections.delete", name, ids.slice(i, i + 1000));
  },
  // Removals by field, then the first documents, in one call; the rest follow.
  replace: async (field, values, docs) => {
    await rpc("collections.replace", name, field, values, docs.slice(0, 200));
    for (let i = 200; i < docs.length; i += 200) await rpc("collections.upsert", name, docs.slice(i, i + 200));
  },
  get: (id) => rpc("collections.get", name, id),
  query: (operation, params, opts) => rpc("collections.query", name, operation, params, opts || {}),
  getMany: async (ids) => {
    const docs = new MapCtor();
    let pending = false;
    for (let i = 0; i < ids.length; i += 1000) {
      const r = await rpc("collections.getMany", name, ids.slice(i, i + 1000));
      for (let j = 0; j < r.docs.length; j++) MapSet(docs, r.docs[j].id, r.docs[j]);
      pending = pending || r.pending;
    }
    return { docs, pending };
  },
  setProfile: (profile) => rpc("collections.setProfile", name, profile),
});
const collectionsOf = (names) => {
  const out = {};
  for (let i = 0; i < names.length; i++) out[names[i]] = collectionHandle(names[i]);
  return ObjectFreeze(out);
};
let initialized = false;
let buffer = "";
const execute = async (message) => {
  if (NumberIsFinite(message.callLimit)) callLimit = message.callLimit;
  const ctx = ObjectFreeze({
    query: handles("query", QUERY_METHODS),
    ...(message.hasAdminQuery ? { adminQuery: adminQueryHandle() } : {}),
    ...(message.hasImages ? { images: handles("images", ["describe", "get", "generate", "edit", "transform"]) } : {}),
    ...(message.hasFonts ? { fonts: handles("fonts", ["find", "inspect", "resolve", "readChunk"]) } : {}),
    ...(message.hasSiteMedia ? { siteMedia: handles("siteMedia", ["find", "inspect", "readChunk"]) } : {}),
    ...(message.hasConsentPurposes ? { consentPurposes: handles("consentPurposes", ["list"]) } : {}),
    ...(message.hasChanges ? { changes: handles("changes", ["cursorState"]) } : {}),
    ...(message.hasPrivateFiles ? { privateFiles: handles("privateFiles", ["begin", "writeChunk", "commit", "stat", "readChunk", "remove"]) } : {}),
    ...(message.hasConfig ? { config: configHandle() } : {}),
    ...(message.collections && message.collections.length > 0 ? { collections: collectionsOf(message.collections) } : {}),
    ...(message.hasChatTools ? { chatTools: ObjectFreeze({ run: (conversation, tool, input, opts) => rpc("chatTools.run", conversation, tool, input, opts || {}) }) } : {}),
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
    if ((message.args.hasOnActivate === true) !== (typeof plugin.onActivate === "function")) throw new ErrorCtor("SandboxOnActivateMismatch: the manifest's hasOnActivate must say whether the definition has an onActivate");
    write({ kind: "result", value: true });
    return;
  }
  let handler;
  if (message.operation === "$staticRender") handler = plugin.staticRender;
  else if (message.operation === "$onActivate") handler = plugin.onActivate;
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
