// SPDX-License-Identifier: MPL-2.0
/**
 * Caelo blue for the live-edit affordances. A literal, not an admin CSS
 * variable: the UI lives inside the operator's own site, which never
 * loads the admin's tokens. White text on it is 5.8:1 (WCAG AA).
 */
export const EDIT_OVERLAY_COLOR = "#2a64b8";
/**
 * Stylesheet of the shadow root that hosts the context menu, the
 * selection toolbar and the target outline. It sits in
 * a shadow root so the site's CSS cannot restyle it and it cannot
 * restyle the site; nothing here touches the site's own elements (an
 * earlier version forced `position:relative` on the hovered module and
 * shifted sticky headers).
 */
export const EDIT_UI_CSS = ":host{all:initial;}" +
    "[hidden]{display:none !important;}" +
    `.outline{position:fixed;pointer-events:none;outline:2px solid ${EDIT_OVERLAY_COLOR};outline-offset:-2px;border-radius:2px;z-index:2147483646;}` +
    '.panel{position:fixed;z-index:2147483647;box-sizing:border-box;min-width:200px;max-width:340px;background:#fff;color:#1a1a1a;border:1px solid #d4d4d8;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:4px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;}' +
    ".panel.bar{display:flex;gap:2px;min-width:0;padding:3px;}" +
    ".caption{padding:6px 8px 4px;color:#52525b;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
    "button{all:unset;box-sizing:border-box;display:block;width:100%;padding:6px 8px;border-radius:5px;cursor:pointer;color:inherit;font:inherit;}" +
    ".bar button{width:auto;white-space:nowrap;}" +
    `button:hover,button:focus-visible{background:${EDIT_OVERLAY_COLOR};color:#fff;}` +
    "button:disabled{opacity:.55;cursor:default;background:none;color:inherit;}" +
    ".actions{display:flex;gap:4px;padding:4px;}" +
    "input{all:unset;box-sizing:border-box;flex:1;min-width:0;padding:6px 8px;border:1px solid #d4d4d8;border-radius:5px;background:#fff;color:#1a1a1a;font:inherit;}" +
    `input:focus{border-color:${EDIT_OVERLAY_COLOR};}` +
    `.actions button{width:auto;background:${EDIT_OVERLAY_COLOR};color:#fff;}` +
    ".field{display:block;padding:4px 8px;font-size:12px;color:#52525b;}" +
    ".field span{display:block;margin-bottom:2px;}" +
    ".field input{display:block;width:100%;color:#1a1a1a;}";
/**
 * Limits mirror `chatSendMessageInput.chips` in `@caelo-cms/shared` so a
 * reference the iframe builds always passes the stream endpoint's schema.
 */
export const REFERENCE_LIMITS = {
    label: 200,
    selector: 500,
    selectedText: 2000,
    context: 500,
};
/**
 * The part of the injected runtime that turns the preview into an
 * editing surface without an edit mode: left click keeps browsing, a
 * right-click inside a module opens the Caelo menu (Shift+right-click
 * keeps the browser's own), and selecting text inside a module shows a
 * small toolbar. Both offer "Ask AI" (reference chip + the chat composer
 * focused for the instruction) and "Add to chat" (reference chip only). The
 * reference carries the selected text and its surrounding text, so the
 * AI knows exactly what the operator meant (CLAUDE.md §1A).
 *
 * The outline marks what the menu or toolbar acts on: the clicked or
 * selected text block (or image), the same element the reference points
 * at. The whole module is outlined only once the operator selects the
 * whole section; outlining the module for a right-click on a headline
 * suggested the action would apply to the entire section.
 *
 * Spliced into `INJECT_SCRIPT`'s closure, so it uses that closure's
 * `postToEditor()` and `findModuleAncestor()`. Written as ES5 in a string, the
 * same as the rest of the runtime: every backslash is doubled because
 * this is a template literal.
 */
export const EDIT_AFFORDANCES_SCRIPT = `
  var UI_CSS = ${JSON.stringify(EDIT_UI_CSS)};
  var LIMITS = ${JSON.stringify(REFERENCE_LIMITS)};
  var ui = null;
  // mode: idle | menu | toolbar | dialog (#918, link editor) | edit (#917,
  // in-place text edit) | scope (#918, shared content: change everywhere
  // or only here?). Selection changes only drive the toolbar; the menu,
  // the link editor and an edit stay until closed explicitly.
  var state = { mode: "idle", outlined: null, onClose: null };

  function clip(s, n) {
    s = String(s || "").replace(/\\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "\\u2026" : s;
  }

  function ensureUi() {
    if (ui) return ui;
    if (!document.body || !document.body.attachShadow) return null;
    var host = document.createElement("caelo-edit-ui");
    var root = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = UI_CSS;
    var outline = document.createElement("div");
    outline.className = "outline";
    outline.hidden = true;
    var panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;
    root.appendChild(style);
    root.appendChild(outline);
    root.appendChild(panel);
    // Keep the page selection alive while the operator clicks our
    // buttons, and keep our clicks away from the site's own handlers.
    panel.addEventListener("mousedown", function (ev) {
      if (!ev.target || ev.target.tagName !== "INPUT") ev.preventDefault();
      ev.stopPropagation();
    });
    panel.addEventListener("click", function (ev) { ev.stopPropagation(); });
    panel.addEventListener("contextmenu", function (ev) { ev.stopPropagation(); });
    document.body.appendChild(host);
    ui = { host: host, outline: outline, panel: panel };
    return ui;
  }

  function isOwnUi(t) {
    return !!(ui && t && (t === ui.host || (ui.host.contains && ui.host.contains(t))));
  }

  function cssPart(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) return s + "#" + el.id;
    if (typeof el.className === "string" && el.className.trim()) {
      s += "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".");
    }
    return s;
  }

  // Path from the module root down to the element, e.g.
  // "section.hero > div.copy > h1". Capped so a deep tree stays readable.
  function selectorFor(el, moduleEl) {
    var parts = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      parts.unshift(cssPart(cur));
      if (cur === moduleEl) break;
      cur = cur.parentNode;
    }
    return clip(parts.join(" > "), LIMITS.selector);
  }

  function labelFor(moduleEl) {
    var aria = moduleEl.getAttribute("aria-label");
    if (aria && aria.trim()) return clip(aria, 80);
    var h = moduleEl.querySelector ? moduleEl.querySelector("h1,h2,h3,h4,h5,h6") : null;
    var heading = h ? clip(h.textContent, 60) : "";
    return heading ? cssPart(moduleEl) + " \\u201c" + heading + "\\u201d" : cssPart(moduleEl);
  }

  var BLOCK = /^(P|LI|H[1-6]|TD|TH|BLOCKQUOTE|FIGCAPTION|BUTTON|A|LABEL|DT|DD)$/;
  function blockFor(el, moduleEl) {
    var cur = el;
    while (cur && cur.nodeType === 1 && cur !== moduleEl) {
      if (BLOCK.test(cur.tagName)) return cur;
      cur = cur.parentNode;
    }
    return el;
  }

  // The element a menu or toolbar acts on: an image itself, else the
  // text block around el (the module root when el is the module).
  function targetOf(el, moduleEl) {
    return el && el.tagName === "IMG" ? el : blockFor(el, moduleEl);
  }

  function elementOf(node) {
    return node && node.nodeType === 1 ? node : node ? node.parentNode : null;
  }

  // The reference points at the outlined element (targetOf); the
  // context stays the surrounding block's text, so an image in a <p> or
  // <a> still tells the AI what it sits next to.
  // Epic #1107 — the stored list entry el sits in (data-caelo-list-item,
  // stamped by the template engine on each entry's root), the innermost
  // one inside this module, or null.
  function listItemOf(el, moduleEl) {
    var cur = el;
    while (cur && cur.nodeType === 1) {
      var v = cur.getAttribute("data-caelo-list-item");
      if (v) return { el: cur, value: v };
      if (cur === moduleEl) break;
      cur = cur.parentNode;
    }
    return null;
  }

  function buildRef(el, moduleEl, selectedText) {
    var block = blockFor(el, moduleEl);
    var entry = listItemOf(el, moduleEl);
    var label = labelFor(moduleEl);
    if (entry) {
      var entryText = clip(entry.el.textContent, 40);
      label = (entryText ? "Entry \u201c" + entryText + "\u201d" : "Entry") + " \u00b7 " + label;
    }
    var ref = {
      moduleId: moduleEl.getAttribute("data-caelo-module-id") || "",
      selector: selectorFor(targetOf(el, moduleEl), moduleEl),
      label: clip(label, LIMITS.label),
    };
    if (entry) ref.listItem = entry.value;
    if (selectedText) ref.selectedText = clip(selectedText, LIMITS.selectedText);
    var context = clip(block.textContent, LIMITS.context);
    if (context && context !== ref.selectedText) ref.context = context;
    return ref;
  }

  // A non-empty selection that lies inside ONE module, or null.
  function currentSelection() {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var text = clip(sel.toString(), LIMITS.selectedText);
    if (!text) return null;
    var range = sel.getRangeAt(0);
    var el = elementOf(range.commonAncestorContainer);
    if (!el || isOwnUi(el)) return null;
    var moduleEl = findModuleAncestor(el);
    if (!moduleEl) return null;
    return { range: range, el: el, moduleEl: moduleEl, text: text };
  }

  function showOutline(el) {
    var u = ensureUi();
    if (!u) return;
    state.outlined = el;
    // A few pixels of air so the line does not touch the text, clamped
    // into the viewport so a full-width module keeps all four sides.
    var r = el.getBoundingClientRect();
    var left = Math.max(0, r.left - 3);
    var top = Math.max(0, r.top - 3);
    var right = Math.min(window.innerWidth, r.right + 3);
    var bottom = Math.min(window.innerHeight, r.bottom + 3);
    u.outline.style.left = left + "px";
    u.outline.style.top = top + "px";
    u.outline.style.width = Math.max(0, right - left) + "px";
    u.outline.style.height = Math.max(0, bottom - top) + "px";
    u.outline.hidden = false;
  }

  function close() {
    // A pending choice (shared content: where does the change apply?)
    // that is closed without an answer is a cancel.
    var onClose = state.onClose;
    state.onClose = null;
    state.mode = "idle";
    state.outlined = null;
    if (onClose) onClose();
    if (!ui) return;
    ui.panel.hidden = true;
    ui.panel.textContent = "";
    ui.outline.hidden = true;
  }

  // Place the panel next to an anchor rect: above it when "above" and
  // there is room, otherwise below, always clamped into the viewport so
  // it never ends up under the site's own fixed navigation off-screen.
  function place(anchor, above) {
    var p = ui.panel;
    p.hidden = false;
    var w = p.offsetWidth;
    var h = p.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var top = above ? anchor.top - h - 8 : anchor.bottom + 4;
    if (above && top < 8) top = anchor.bottom + 8;
    if (top + h > vh - 8) top = Math.max(8, anchor.top - h - 4);
    var left = above ? anchor.left + anchor.width / 2 - w / 2 : anchor.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    p.style.left = left + "px";
    p.style.top = top + "px";
  }

  function pointRect(x, y) {
    return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
  }

  // A disabled button says why in its tooltip (disabledReason).
  function button(label, testid, onClick, disabledReason) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("data-testid", testid);
    if (disabledReason) {
      b.disabled = true;
      b.title = disabledReason;
    }
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      onClick();
    });
    return b;
  }

  function caption(text) {
    var c = document.createElement("div");
    c.className = "caption";
    c.textContent = text;
    return c;
  }

  // ask: the operator picked Ask AI. The message carries no instruction:
  // the instruction is typed and sent in the editor's own composer, never
  // taken from this frame (see ChatPanel's caelo:chip handler).
  function post(ref, ask) {
    var msg = {
      kind: "caelo:element-referenced",
      moduleId: ref.moduleId,
      selector: ref.selector,
      label: ref.label,
    };
    if (ref.selectedText) msg.selectedText = ref.selectedText;
    if (ref.context) msg.context = ref.context;
    if (ref.listItem) msg.listItem = ref.listItem;
    if (ref.field) {
      msg.blockName = ref.blockName;
      msg.position = ref.position;
      msg.field = ref.field;
      if (ref.item !== undefined) msg.item = ref.item;
      if (ref.key !== undefined) msg.key = ref.key;
    }
    if (ask) msg.ask = true;
    postToEditor(msg);
  }

  // What the operator sees: the text they picked or clicked, never the
  // element path or class names (those are for the AI).
  function refCaption(ref) {
    var text = ref.selectedText || ref.context;
    return text ? "\\u201c" + clip(text, 48) + "\\u201d" : "This section";
  }

  function openMenu(ref, moduleEl, target, x, y, f, t) {
    var u = ensureUi();
    if (!u) return;
    state.mode = "menu";
    showOutline(target);
    u.panel.className = "panel";
    u.panel.textContent = "";
    u.panel.setAttribute("role", "menu");
    u.panel.setAttribute("data-testid", "caelo-context-menu");
    u.panel.appendChild(caption(refCaption(ref)));
    if (f) {
      u.panel.appendChild(
        button("Edit text", "caelo-menu-edit", function () { startEdit(f); }),
      );
    }
    var link = t ? linkAt(t, moduleEl) : null;
    if (link) {
      u.panel.appendChild(
        button("Edit link\u2026", "caelo-menu-edit-link", function () { openLinkEditor(link, x, y); }),
      );
    }
    var image = imageAt(t);
    if (image) {
      u.panel.appendChild(
        button("Replace image\u2026", "caelo-menu-replace-image", function () {
          close();
          requestImageReplace(image, moduleEl, x, y);
        }),
      );
    }
    u.panel.appendChild(
      button(ref.selectedText ? "Ask AI about this text\\u2026" : "Ask AI about this\\u2026", "caelo-menu-ask", function () {
        post(ref, true);
        close();
      }),
    );
    u.panel.appendChild(
      button("Add to chat as reference", "caelo-menu-reference", function () {
        post(ref);
        close();
      }),
    );
    u.panel.appendChild(
      button("Select whole section", "caelo-menu-select-section", function () {
        close();
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(moduleEl);
        sel.removeAllRanges();
        sel.addRange(range);
        refreshToolbar();
      }),
    );
    place(pointRect(x, y), false);
  }

  function openToolbar(s) {
    var u = ensureUi();
    if (!u) return;
    state.mode = "toolbar";
    showOutline(targetOf(s.el, s.moduleEl));
    var f = fieldOfSelection(s);
    var ref = withField(buildRef(s.el, s.moduleEl, s.text), f);
    var anchor = s.range.getBoundingClientRect();
    u.panel.className = "panel bar";
    u.panel.textContent = "";
    u.panel.setAttribute("role", "toolbar");
    u.panel.setAttribute("data-testid", "caelo-selection-toolbar");
    if (f) {
      u.panel.appendChild(button("Edit", "caelo-toolbar-edit", function () { startEdit(f); }));
    }
    u.panel.appendChild(
      button("Ask AI", "caelo-toolbar-ask", function () {
        post(ref, true);
        close();
      }),
    );
    u.panel.appendChild(
      button("Add to chat", "caelo-toolbar-reference", function () {
        post(ref);
        close();
      }),
    );
    place(anchor, true);
  }

  function refreshToolbar() {
    if (state.mode !== "idle" && state.mode !== "toolbar") return;
    var s = currentSelection();
    if (s) openToolbar(s);
    else if (state.mode === "toolbar") close();
  }

  document.addEventListener(
    "contextmenu",
    function (ev) {
      if (isOwnUi(ev.target) || isEditing(ev.target)) return;
      if (ev.shiftKey) {
        close();
        return;
      }
      var t = ev.target && ev.target.nodeType === 1 ? ev.target : null;
      var moduleEl = t ? findModuleAncestor(t) : null;
      if (!moduleEl) {
        close();
        return;
      }
      ev.preventDefault();
      var s = currentSelection();
      var inSelection = s && s.moduleEl === moduleEl;
      var f = inSelection ? fieldOfSelection(s) : fieldAt(t, moduleEl);
      var ref = withField(
        inSelection ? buildRef(s.el, moduleEl, s.text) : buildRef(t, moduleEl, ""),
        f,
      );
      var target = inSelection ? targetOf(s.el, moduleEl) : targetOf(t, moduleEl);
      openMenu(ref, moduleEl, target, ev.clientX, ev.clientY, f, t);
    },
    true,
  );

  // A button a plugin's editor notice offers (an omitted module: why it
  // is missing from the page) does what Ask AI does for that module: the
  // notice's text rides on the chip as context, the instruction is typed
  // in the editor's composer.
  document.addEventListener(
    "click",
    function (ev) {
      var t = ev.target && ev.target.nodeType === 1 ? ev.target : null;
      var btn = t && t.closest ? t.closest("[data-caelo-ask-ai]") : null;
      if (!btn || isOwnUi(btn)) return;
      var moduleEl = findModuleAncestor(btn);
      if (!moduleEl) return;
      ev.preventDefault();
      var ref = buildRef(moduleEl, moduleEl, "");
      var context = clip(
        (moduleEl.textContent || "").replace(btn.textContent || "", " "),
        LIMITS.context,
      );
      if (context) ref.context = context;
      post(ref, true);
    },
    true,
  );

  document.addEventListener(
    "mousedown",
    function (ev) {
      if (state.mode === "idle" || state.mode === "edit" || isOwnUi(ev.target)) return;
      close();
    },
    true,
  );

  // Toolbar appears once a drag or keyboard selection settles, not on
  // every selectionchange tick mid-drag.
  document.addEventListener("mouseup", function () { setTimeout(refreshToolbar, 0); });
  document.addEventListener("keyup", function (ev) {
    if (ev.key === "Shift" || ev.shiftKey) setTimeout(refreshToolbar, 0);
  });
  document.addEventListener("selectionchange", function () {
    if (state.mode === "toolbar" && !currentSelection()) close();
  });

  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && state.mode !== "idle") close();
  });

  function onViewportChange() {
    if (state.mode === "menu") close();
    else if (state.mode === "toolbar") refreshToolbar();
    else if (state.mode === "dialog" && state.outlined) showOutline(state.outlined);
  }
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);
`;
