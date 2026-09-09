// SPDX-License-Identifier: MPL-2.0

/** Trusted bootstrap source, bundled with the validated plugin before isolated execution. */
export const sandboxEntrySource = `
import plugin from "caelo:plugin";
const encoder = new TextEncoder();
const write = (value, strictCas = false) => {
  // Losing a field or converting NaN to null would change a CAS predicate.
  // Validate during serialization, before anything reaches the host.
  const json = JSON.stringify(value, strictCas ? (_key, item) => {
    if (item === undefined || ["function", "symbol", "bigint"].includes(typeof item)
      || (typeof item === "number" && !Number.isFinite(item)))
      throw new Error("compareAndSwap requires JSON values; undefined and non-finite values are forbidden");
    return item;
  } : undefined);
  const bytes = encoder.encode(json + "\\n");
  if (bytes.length > 1048576) throw new Error("SandboxMessageTooLarge");
  let offset = 0;
  while (offset < bytes.length) offset += Deno.stdout.writeSync(bytes.subarray(offset));
};
// Plugin logging cannot corrupt the protocol or exhaust a host-side stderr buffer.
console.log = console.info = console.debug = console.warn = console.error = () => {};
const pending = new Map();
let nextId = 0;
const rpc = (method, ...args) => new Promise((resolve, reject) => {
  if (nextId >= 256) return reject(new Error("SandboxCallLimit"));
  const id = nextId;
  pending.set(id, { resolve, reject });
  try {
    write({ kind: "call", id, method, args },
      method === "query.compareAndSwap" || method === "adminQuery.compareAndSwap");
    nextId++;
  } catch (error) {
    pending.delete(id);
    reject(error);
  }
});
let initialized = false;
let buffer = "";
const decoder = new TextDecoder();
const execute = async (message) => {
  const query = Object.fromEntries(["insert", "list", "update", "compareAndSwap", "delete"].map(
    (name) => [name, (...args) => rpc("query." + name, ...args)]));
  const ctx = Object.freeze({
    query: Object.freeze(query),
    api: Object.freeze({ list: (...args) => rpc("api.list", ...args), get: (...args) => rpc("api.get", ...args) }),
    captcha: Object.freeze({ requireProof: (...args) => rpc("captcha.requireProof", ...args) }),
    theme: Object.freeze(message.theme), visitor: Object.freeze(message.visitor),
  });
  if (!plugin || plugin.slug !== message.slug || plugin.version !== message.version || plugin.tier !== 2)
    throw new Error("SandboxDefinitionMismatch");
  let handler;
  if (message.operation === "$staticRender") handler = plugin.staticRender;
  else handler = Object.hasOwn(plugin.operations, message.operation) && plugin.operations[message.operation];
  if (typeof handler !== "function") throw new Error("SandboxOperationNotDeclared");
  const value = await handler(ctx, message.args);
  if (pending.size) throw new Error("SandboxUnawaitedCall");
  write({ kind: "result", value: value === undefined ? null : value });
};
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  if (buffer.length > 1048576) throw new Error("SandboxMessageTooLarge");
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
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
