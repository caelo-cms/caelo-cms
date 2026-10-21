// SPDX-License-Identifier: MPL-2.0

import { EDIT_OVERLAY_COLOR } from "./edit-affordances-script.js";

/**
 * #917 / #918 — in-place editing in the Live Edit preview. The preview
 * marks each placement field's text with comments
 * (`<!--caelo:f p=<block>#<pos> s=<shared pages> f=<field>[.<i>[.<part>]]-->text<!--/caelo:f-->`)
 * and link targets / images / alt text with `data-caelo-fields` on their
 * tag (see `edit-markers.ts` in `@caelo-cms/shared`). This runtime finds
 * the marked field under a right-click or a selection, makes exactly that
 * text editable, and saves by posting `caelo:field-edit` (one or more
 * edits of one placement) to the editor, which writes them through
 * `page_module_content.patch_fields` and reloads the preview. Escape
 * restores the text. Shared content (`s` > 1) first asks whether to
 * change it on every page or only on this one.
 *
 * Spliced into `INJECT_SCRIPT`'s closure next to
 * `EDIT_AFFORDANCES_SCRIPT` and `LINK_IMAGE_EDIT_SCRIPT`; function
 * declarations are hoisted across all three. ES5 in a template literal:
 * every backslash is doubled.
 */
export const FIELD_EDIT_SCRIPT = `
  var MARKER = /^caelo:f p=(\\S+) s=(\\d+) f=(\\S+)$/;
  var SHOW_COMMENT = 128;
  // Page paths + titles for link-target suggestions, sent by the editor.
  var pagePaths = [];

  function follows(node, ref) {
    return !!(ref.compareDocumentPosition(node) & 4);
  }

  // "links.0.href" -> { field: "links", index: 0, part: "href" }
  function parsePath(raw) {
    var path = decodeURIComponent(raw).split(".");
    var out = { field: path[0] };
    if (path.length > 1) out.index = Number(path[1]);
    if (path.length > 2) out.part = path[2];
    return out;
  }

  function placementOf(raw) {
    var p = decodeURIComponent(raw);
    var hash = p.lastIndexOf("#");
    return { blockName: p.slice(0, hash), position: Number(p.slice(hash + 1)) };
  }

  function parseField(open, close, m) {
    if (open.parentNode !== close.parentNode) return null;
    var at = placementOf(m[1]);
    var path = parsePath(m[3]);
    return {
      open: open,
      close: close,
      blockName: at.blockName,
      position: at.position,
      shared: Number(m[2]),
      field: path.field,
      index: path.index,
      part: path.part,
    };
  }

  // The marked field that holds node: the pair around it, or, when node
  // is an element (a right-click target), the only pair inside it.
  function fieldAt(node, moduleEl) {
    if (!node || !moduleEl || !document.createTreeWalker) return null;
    var walker = document.createTreeWalker(moduleEl, SHOW_COMMENT);
    var stack = [];
    var inside = [];
    var c;
    while ((c = walker.nextNode())) {
      var data = c.data.trim();
      if (data === "/caelo:f") {
        var open = stack.pop();
        if (!open) continue;
        if (follows(node, open.node) && follows(c, node)) return parseField(open.node, c, open.m);
        if (node.nodeType === 1 && node.contains(open.node)) inside.push({ open: open, close: c });
        continue;
      }
      var m = MARKER.exec(data);
      if (m) stack.push({ node: c, m: m });
    }
    return inside.length === 1 ? parseField(inside[0].open.node, inside[0].close, inside[0].open.m) : null;
  }

  // The field a selection lies in, when it starts and ends in the same one.
  function fieldOfSelection(s) {
    var start = fieldAt(s.range.startContainer, s.moduleEl);
    if (!start) return null;
    var end = fieldAt(s.range.endContainer, s.moduleEl);
    return end && end.open === start.open ? start : null;
  }

  // Marked attributes of an element: { at, shared, fields: { href|src|alt: path } }.
  function attrFields(el) {
    var raw = el && el.getAttribute ? el.getAttribute("data-caelo-fields") : null;
    if (!raw) return null;
    var fields = {};
    raw.split(" ").forEach(function (pair) {
      var eq = pair.indexOf("=");
      if (eq > 0) fields[pair.slice(0, eq)] = parsePath(pair.slice(eq + 1));
    });
    return {
      at: placementOf(el.getAttribute("data-caelo-placement") || ""),
      shared: Number(el.getAttribute("data-caelo-shared") || "0"),
      fields: fields,
    };
  }

  function withField(ref, f) {
    if (!f) return ref;
    ref.blockName = f.blockName;
    ref.position = f.position;
    ref.field = f.field;
    if (f.index !== undefined) ref.index = f.index;
    return ref;
  }

  function edit(path, text) {
    var e = { field: path.field, text: text };
    if (path.index !== undefined) e.index = path.index;
    if (path.part !== undefined) e.part = path.part;
    return e;
  }

  function postEdits(at, edits, scope) {
    var ctx = window.__caelo || {};
    var msg = {
      kind: "caelo:field-edit",
      pageId: ctx.pageId || "",
      blockName: at.blockName,
      position: at.position,
      edits: edits,
    };
    if (scope) msg.scope = scope;
    postToEditor(msg);
  }

  // Shared content (on more than one page) asks where the change applies;
  // shared content on this page alone simply changes. onCancel runs when
  // the operator backs out (Escape, Cancel, a click elsewhere).
  function chooseScope(shared, anchor, onScope, onCancel) {
    if (shared <= 1) {
      onScope(shared === 1 ? "everywhere" : undefined);
      return;
    }
    var u = ensureUi();
    if (!u) return;
    state.mode = "scope";
    state.onClose = onCancel;
    u.panel.className = "panel";
    u.panel.textContent = "";
    u.panel.setAttribute("role", "dialog");
    u.panel.setAttribute("data-testid", "caelo-scope");
    u.panel.appendChild(caption("This appears on " + shared + " pages."));
    function pick(scope) {
      state.onClose = null;
      close();
      onScope(scope);
    }
    u.panel.appendChild(
      button("Change on all " + shared + " pages", "caelo-scope-everywhere", function () { pick("everywhere"); }),
    );
    u.panel.appendChild(button("Only on this page", "caelo-scope-here", function () { pick("here"); }));
    u.panel.appendChild(button("Cancel", "caelo-scope-cancel", function () { close(); }));
    place(anchor, false);
  }

  function saveEdits(at, edits, shared, anchor, onCancel) {
    chooseScope(shared, anchor, function (scope) { postEdits(at, edits, scope); }, onCancel);
  }

  function startEdit(f) {
    close();
    state.mode = "edit";
    var span = document.createElement("span");
    span.setAttribute("data-caelo-editing", "");
    var n = f.open.nextSibling;
    while (n && n !== f.close) {
      var next = n.nextSibling;
      span.appendChild(n);
      n = next;
    }
    f.close.parentNode.insertBefore(span, f.close);
    var original = span.textContent;
    span.contentEditable = "plaintext-only";
    if (span.contentEditable !== "plaintext-only") span.contentEditable = "true";
    span.style.outline = "2px solid ${EDIT_OVERLAY_COLOR}";
    span.style.outlineOffset = "2px";
    span.style.borderRadius = "2px";
    span.style.cursor = "text";
    span.focus();
    var range = document.createRange();
    range.selectNodeContents(span);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    var done = false;
    function restore() {
      span.textContent = original;
      while (span.firstChild) span.parentNode.insertBefore(span.firstChild, span);
      span.parentNode.removeChild(span);
    }
    function finish(save) {
      if (done) return;
      done = true;
      state.mode = "idle";
      span.contentEditable = "false";
      var text = span.textContent.replace(/\\s+/g, " ").trim();
      if (!save || text === original.replace(/\\s+/g, " ").trim()) {
        restore();
        return;
      }
      // Saving: the editor reloads the preview once the write lands (or
      // fails, which also restores the stored text).
      span.removeAttribute("data-caelo-editing");
      span.setAttribute("data-caelo-saving", "");
      span.style.opacity = "0.6";
      saveEdits(
        { blockName: f.blockName, position: f.position },
        [edit(f, text)],
        f.shared,
        span.getBoundingClientRect(),
        restore,
      );
    }
    span.addEventListener("keydown", function (ev) {
      ev.stopPropagation();
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    });
    span.addEventListener("paste", function (ev) {
      if (span.contentEditable === "plaintext-only" || !ev.clipboardData) return;
      ev.preventDefault();
      document.execCommand("insertText", false, ev.clipboardData.getData("text/plain"));
    });
    span.addEventListener("blur", function () { finish(true); });
  }

  function isEditing(t) {
    var cur = t;
    while (cur && cur.nodeType === 1) {
      if (cur.hasAttribute && cur.hasAttribute("data-caelo-editing")) return true;
      cur = cur.parentNode;
    }
    return false;
  }
`;
