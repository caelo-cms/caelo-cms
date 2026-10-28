// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1198 — the AST plumbing of the module-JS analysis
 * (module-js-analysis.ts): a walk over oxc-parser's ESTree output and the
 * lexical resolution of identifiers to their declarations.
 *
 * Resolution is by function scope: `let` / `const` in a block are treated
 * as declared in the enclosing function. That is enough for what the
 * analysis asks — "is this `items` the content array declared over there?"
 * — where two IIFEs that each declare their own `items` are the case that
 * matters (Codex review on #1199): name matching alone would let one
 * IIFE's DOM write render the other one's array.
 */

/** A loosely typed ESTree node as oxc-parser returns it. */
export interface Node {
  readonly type: string;
  readonly [key: string]: unknown;
}

export function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

/** Every node of a subtree, depth first. */
export function* nodes(root: unknown): Generator<Node> {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (isNode(v)) {
      yield v;
      for (const [key, child] of Object.entries(v)) {
        if (key !== "type" && typeof child === "object" && child !== null) stack.push(child);
      }
    }
  }
}

const SCOPE_TYPES = new Set([
  "Program",
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Identifiers and their declarations in one script. */
export class JsScopes {
  private readonly parents = new Map<Node, Node>();
  private readonly decls = new Map<Node, Map<string, Node>>();
  /** Identifiers that name a property or a declaration, not a read. */
  private readonly nonRefs = new Set<Node>();

  constructor(program: Node) {
    const stack: Node[] = [program];
    while (stack.length > 0) {
      const n = stack.pop() as Node;
      for (const [key, child] of Object.entries(n)) {
        if (key === "type") continue;
        for (const c of Array.isArray(child) ? child : [child]) {
          if (!isNode(c)) continue;
          this.parents.set(c, n);
          stack.push(c);
        }
      }
    }
    for (const n of nodes(program)) {
      if (n.type === "MemberExpression" && n.computed !== true && isNode(n.property)) {
        this.nonRefs.add(n.property);
      }
      if (n.type === "Property" && n.computed !== true && isNode(n.key)) this.nonRefs.add(n.key);
      if (n.type === "VariableDeclarator" && isNode(n.id) && n.id.type === "Identifier") {
        this.nonRefs.add(n.id);
        this.declare(this.scopeOf(n), n.id.name as string, n);
      }
      if (SCOPE_TYPES.has(n.type) && n.type !== "Program") {
        // A parameter shadows an outer binding of the same name.
        for (const p of (n.params as unknown[] | undefined) ?? []) {
          if (isNode(p) && p.type === "Identifier") {
            this.nonRefs.add(p);
            this.declare(n, p.name as string, p);
          }
        }
      }
    }
  }

  /** Is this identifier a read of a binding (not `x.name` / `{ name: … }` / a declaration)? */
  isReference(n: Node): boolean {
    return n.type === "Identifier" && !this.nonRefs.has(n);
  }

  /**
   * The declaration an identifier reads: its `VariableDeclarator`, or the
   * parameter it names; null for globals (`document`) and unknown names.
   */
  resolve(ident: Node): Node | null {
    if (!this.isReference(ident)) return null;
    const name = ident.name as string;
    for (let s: Node | null = this.scopeOf(ident); s !== null; s = this.outer(s)) {
      const d = this.decls.get(s)?.get(name);
      if (d) return d;
    }
    return null;
  }

  private declare(scope: Node, name: string, decl: Node): void {
    const map = this.decls.get(scope) ?? new Map<string, Node>();
    map.set(name, decl);
    this.decls.set(scope, map);
  }

  /** The function (or the program) a node sits in. */
  private scopeOf(n: Node): Node {
    let p = this.parents.get(n);
    while (p !== undefined && !SCOPE_TYPES.has(p.type)) p = this.parents.get(p);
    return p ?? n;
  }

  private outer(scope: Node): Node | null {
    return scope.type === "Program" ? null : this.scopeOf(scope);
  }
}
