// SPDX-License-Identifier: MPL-2.0

/**
 * Test support: the little of the DOM the comments runtime touches, and a
 * parser for well-formed markup into it, so tests run the shipped
 * `runtime.js` over the real bake and the markup the skill teaches.
 * Test-only: the package build excludes it (tsconfig.json).
 */

const VOID_TAGS = new Set(["input", "br", "img", "meta", "link", "hr"]);

function decode(s: string): string {
  return s
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** One compound selector: an optional tag and `[name]` / `[name="value"]` parts. */
interface Compound {
  tag: string | null;
  attrs: { name: string; value: string | null }[];
}

function parseSelector(selector: string): Compound {
  const m = /^([a-z]+)?((?:\[[^\]]+\])*)$/i.exec(selector.trim());
  if (!m) throw new Error(`unsupported selector ${selector}`);
  const attrs = [...(m[2] ?? "").matchAll(/\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/g)].map(
    (a) => ({ name: a[1] as string, value: a[2] ?? a[3] ?? null }),
  );
  return { tag: m[1]?.toLowerCase() ?? null, attrs };
}

export class El {
  attrs = new Map<string, string>();
  children: El[] = [];
  parent: El | null = null;
  text = "";
  disabled = false;
  value = "";
  valid = true;
  listeners = new Map<string, ((ev: { preventDefault: () => void }) => void)[]>();

  constructor(readonly tag: string) {}

  get className(): string {
    return this.attrs.get("class") ?? "";
  }
  set className(v: string) {
    this.attrs.set("class", v);
  }
  get hidden(): boolean {
    return this.attrs.has("hidden");
  }
  set hidden(v: boolean) {
    if (v) this.attrs.set("hidden", "");
    else this.attrs.delete("hidden");
  }
  get maxLength(): number {
    const v = this.attrs.get("maxlength");
    return v === undefined ? -1 : Number(v);
  }
  set maxLength(v: number) {
    this.attrs.set("maxlength", String(v));
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === "disabled") this.disabled = true;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  appendChild(child: El): void {
    child.parent = this;
    this.children.push(child);
  }
  insertBefore(child: El, ref: El | undefined): void {
    child.parent = this;
    this.children.splice(ref ? this.children.indexOf(ref) : 0, 0, child);
  }
  get firstChild(): El | undefined {
    return this.children[0];
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get textContent(): string {
    return this.children.length > 0 ? this.children.map((c) => c.textContent).join("") : this.text;
  }
  addEventListener(event: string, fn: (ev: { preventDefault: () => void }) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
  }
  /** Fire `event`; whether a listener prevented the browser's default. */
  dispatch(event: string): boolean {
    let prevented = false;
    for (const fn of this.listeners.get(event) ?? []) {
      fn({
        preventDefault: () => {
          prevented = true;
        },
      });
    }
    return prevented;
  }
  click(): void {
    if (!this.disabled) this.dispatch("click");
  }
  reset(): void {
    for (const el of this.walk()) if (el.tag === "input" || el.tag === "textarea") el.value = "";
  }
  reportValidity(): boolean {
    return this.valid;
  }
  matches(selector: string): boolean {
    const c = parseSelector(selector);
    if (c.tag && c.tag !== this.tag) return false;
    return c.attrs.every((a) =>
      a.value === null ? this.attrs.has(a.name) : this.attrs.get(a.name) === a.value,
    );
  }
  closest(selector: string): El | null {
    for (let el: El | null = this; el; el = el.parent) if (el.matches(selector)) return el;
    return null;
  }
  walk(): El[] {
    return this.children.flatMap((c) => [c, ...c.walk()]);
  }
  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): El[] {
    return this.walk().filter((e) => e.tag !== "#text" && e.matches(selector));
  }
}

const isSpace = (c: string | undefined) => c === " " || c === "\n" || c === "\t" || c === "\r";

/**
 * Parse well-formed markup (what the bake and the skill write) into
 * `parent`. One forward pass, character by character: no backtracking
 * regex over the markup (CodeQL js/redos).
 */
export function parseInto(parent: El, html: string): El {
  const stack = [parent];
  const n = html.length;
  let i = 0;
  const top = () => stack[stack.length - 1] as El;
  while (i < n) {
    if (html[i] !== "<") {
      const end = html.indexOf("<", i);
      const stop = end === -1 ? n : end;
      const t = new El("#text");
      t.text = decode(html.slice(i, stop));
      top().appendChild(t);
      i = stop;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const closing = html[i + 1] === "/";
    let j = i + (closing ? 2 : 1);
    const nameStart = j;
    while (j < n && !isSpace(html[j]) && html[j] !== ">" && html[j] !== "/") j++;
    const tag = html.slice(nameStart, j).toLowerCase();
    if (closing) {
      const end = html.indexOf(">", j);
      i = end === -1 ? n : end + 1;
      while (stack.length > 1 && (stack.pop() as El).tag !== tag) {
        /* unwind to the matching open tag */
      }
      continue;
    }
    const el = new El(tag);
    while (j < n && html[j] !== ">") {
      if (isSpace(html[j]) || html[j] === "/") {
        j++;
        continue;
      }
      const attrStart = j;
      while (j < n && !isSpace(html[j]) && html[j] !== "=" && html[j] !== ">" && html[j] !== "/")
        j++;
      const name = html.slice(attrStart, j).toLowerCase();
      let value = "";
      if (html[j] === "=") {
        j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, j + 1);
          const stop = close === -1 ? n : close;
          value = html.slice(j + 1, stop);
          j = stop + 1;
        } else {
          const valueStart = j;
          while (j < n && !isSpace(html[j]) && html[j] !== ">") j++;
          value = html.slice(valueStart, j);
        }
      }
      if (name) el.attrs.set(name, decode(value));
    }
    i = j + 1;
    if (el.attrs.has("disabled")) el.disabled = true;
    top().appendChild(el);
    if (!VOID_TAGS.has(el.tag)) stack.push(el);
  }
  return parent;
}

/** A document over one parsed `<html>` tree. */
export function fakeDocument(root: El, ready: (() => void)[]) {
  return {
    readyState: "interactive",
    documentElement: root,
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    createElement: (tag: string) => new El(tag),
    createTextNode: (text: string) => {
      const t = new El("#text");
      t.text = text;
      return t;
    },
    addEventListener: (event: string, fn: () => void) => {
      if (event === "DOMContentLoaded") ready.push(fn);
    },
  };
}
