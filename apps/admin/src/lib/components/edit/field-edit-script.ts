// SPDX-License-Identifier: MPL-2.0

import { EDIT_OVERLAY_COLOR } from "./edit-affordances-script.js";

/**
 * #917 — in-place text editing in the Live Edit preview. The preview
 * marks each placement field's text with comments
 * (`<!--caelo:f p=<block>#<pos> s=<0|1> f=<field>[.<i>[.label]]-->text<!--/caelo:f-->`,
 * see `edit-markers.ts` in `@caelo-cms/shared`). This runtime finds the
 * marked field under a right-click or a selection, makes exactly that
 * text editable, and on Enter / blur posts `caelo:field-edit` to the
 * editor, which saves it through `page_module_content.patch_fields` and
 * reloads the preview. Escape restores the text.
 *
 * Spliced into `INJECT_SCRIPT`'s closure next to
 * `EDIT_AFFORDANCES_SCRIPT`, which calls `fieldAt()` / `startEdit()`;
 * function declarations are hoisted across both. ES5 in a template
 * literal: every backslash is doubled.
 */
export const FIELD_EDIT_SCRIPT = `
  var MARKER = /^caelo:f p=(\\S+) s=([01]) f=(\\S+)$/;
  var SHOW_COMMENT = 128;

  function follows(node, ref) {
    return !!(ref.compareDocumentPosition(node) & 4);
  }

  function parseField(open, close, m) {
    if (open.parentNode !== close.parentNode) return null;
    var placement = decodeURIComponent(m[1]);
    var hash = placement.lastIndexOf("#");
    var path = decodeURIComponent(m[3]).split(".");
    var field = {
      open: open,
      close: close,
      blockName: placement.slice(0, hash),
      position: Number(placement.slice(hash + 1)),
      synced: m[2] === "1",
      field: path[0],
    };
    if (path.length > 1) field.index = Number(path[1]);
    return field;
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

  function withField(ref, f) {
    if (!f) return ref;
    ref.blockName = f.blockName;
    ref.position = f.position;
    ref.field = f.field;
    if (f.index !== undefined) ref.index = f.index;
    return ref;
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
    function unwrap() {
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
        span.textContent = original;
        unwrap();
        return;
      }
      // Saving: the editor reloads the preview once the write lands (or
      // fails, which also restores the stored text).
      span.removeAttribute("data-caelo-editing");
      span.setAttribute("data-caelo-saving", "");
      span.style.opacity = "0.6";
      var ctx = window.__caelo || {};
      var msg = {
        kind: "caelo:field-edit",
        pageId: ctx.pageId || "",
        blockName: f.blockName,
        position: f.position,
        field: f.field,
        text: text,
      };
      if (f.index !== undefined) msg.index = f.index;
      parent.postMessage(msg, origin());
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
