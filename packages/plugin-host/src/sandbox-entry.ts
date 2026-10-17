// SPDX-License-Identifier: MPL-2.0

/** Trusted bootstrap source, bundled with the validated plugin before isolated execution. */
export const sandboxEntrySource = `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JSONParse = JSON.parse;
const JSONStringify = JSON.stringify;
const MapCtor = Map;
const ObjectFreeze = Object.freeze;
const ObjectFromEntries = Object.fromEntries;
const ObjectHasOwn = Object.hasOwn;
const NumberIsFinite = Number.isFinite;
const stdoutWriteSync = Deno.stdout.writeSync.bind(Deno.stdout);
const stdinReadable = Deno.stdin.readable;
try { delete globalThis.Deno; } catch {}
import plugin from "caelo:plugin";
const write = (value, strictCas = false) => {
  // Losing a field or converting NaN to null would change a CAS predicate.
  // Validate during serialization, before anything reaches the host.
  const json = JSONStringify(value, strictCas ? (_key, item) => {
    if (item === undefined || ["function", "symbol", "bigint"].includes(typeof item)
      || (typeof item === "number" && !NumberIsFinite(item)))
      throw new Error("compareAndSwap requires JSON values; undefined and non-finite values are forbidden");
    return item;
  } : undefined);
  const bytes = encoder.encode(json + "\\n");
  if (bytes.length > 1048576) throw new Error("SandboxMessageTooLarge");
  let offset = 0;
  while (offset < bytes.length) offset += stdoutWriteSync(bytes.subarray(offset));
};
// Plugin logging cannot corrupt the protocol or exhaust a host-side stderr buffer.
console.log = console.info = console.debug = console.warn = console.error = () => {};
const pending = new MapCtor();
let nextId = 0;
const rpc = (method, ...args) => new Promise((resolve, reject) => {
  if (nextId >= 1024) return reject(new Error("SandboxCallLimit"));
  const id = nextId;
  pending.set(id, { resolve, reject });
  // A refused call consumes no sequence number and leaves nothing pending,
  // so the plugin can catch the error and keep going.
  try {
    write({ kind: "call", id, method, args }, method.endsWith(".compareAndSwap"));
    nextId++;
  } catch (error) {
    pending.delete(id);
    reject(error);
  }
});
let initialized = false;
let buffer = "";
const execute = async (message) => {
  const query = ObjectFromEntries(["insert", "list", "update", "compareAndSwap", "delete"].map(
    (name) => [name, (...args) => rpc("query." + name, ...args)]));
  const ctx = ObjectFreeze({
    query: ObjectFreeze(query),
    ...(message.hasAdminQuery ? { adminQuery: ObjectFreeze(ObjectFromEntries(["insert", "list", "update", "compareAndSwap", "delete"].map(name => [name, (...args) => rpc("adminQuery." + name, ...args)]))) } : {}),
    ...(message.hasImages ? { images: ObjectFreeze(ObjectFromEntries(["describe", "get", "generate", "edit", "transform"].map(name => [name, (...args) => rpc("images." + name, ...args)]))) } : {}),
    ...(message.hasFonts ? { fonts: ObjectFreeze(ObjectFromEntries(["find", "inspect", "resolve", "readChunk"].map(name => [name, (...args) => rpc("fonts." + name, ...args)]))) } : {}),
    ...(message.hasSiteMedia ? { siteMedia: ObjectFreeze(ObjectFromEntries(["find", "inspect", "readChunk"].map(name => [name, (...args) => rpc("siteMedia." + name, ...args)]))) } : {}),
    ...(message.hasPrivateFiles ? { privateFiles: ObjectFreeze(ObjectFromEntries(["begin", "writeChunk", "commit", "stat", "readChunk", "remove"].map(name => [name, (...args) => rpc("privateFiles." + name, ...args)]))) } : {}),
    api: ObjectFreeze({ list: (...args) => rpc("api.list", ...args), get: (...args) => rpc("api.get", ...args) }),
    captcha: ObjectFreeze({ requireProof: (...args) => rpc("captcha.requireProof", ...args) }),
    theme: ObjectFreeze(message.theme), visitor: ObjectFreeze(message.visitor),
    invocation: ObjectFreeze(message.invocation),
  });
  if (!plugin || plugin.slug !== message.slug || plugin.version !== message.version || plugin.tier !== 2)
    throw new Error("SandboxDefinitionMismatch");
  if (message.operation === "$inspect") {
    for (const name of message.args.operations) if (typeof plugin.operations?.[name] !== "function") throw new Error("SandboxOperationNotDeclared: " + name);
    if (message.args.hasStaticRender && typeof plugin.staticRender !== "function") throw new Error("SandboxStaticRenderMissing");
    write({ kind: "result", value: true });
    return;
  }
  let handler;
  if (message.operation === "$staticRender") handler = plugin.staticRender;
  else handler = ObjectHasOwn(plugin.operations, message.operation) && plugin.operations[message.operation];
  if (typeof handler !== "function") throw new Error("SandboxOperationNotDeclared");
  const value = await handler(ctx, message.args);
  if (pending.size) throw new Error("SandboxUnawaitedCall");
  write({ kind: "result", value: value === undefined ? null : value });
};
for await (const chunk of stdinReadable) {
  buffer += decoder.decode(chunk, { stream: true });
  if (buffer.length > 1048576) throw new Error("SandboxMessageTooLarge");
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const message = JSONParse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (!initialized) {
      initialized = true;
      execute(message).catch((error) => write({ kind: "error", message: String(error.message ?? error).slice(0, 4000) }));
    } else {
      const call = pending.get(message.id);
      if (!call) throw new Error("SandboxUnexpectedResponse");
      pending.delete(message.id);
      if (message.ok) call.resolve(message.value);
      else call.reject(new Error(message.message));
    }
  }
}
`;
