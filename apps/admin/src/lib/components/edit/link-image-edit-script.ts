// SPDX-License-Identifier: MPL-2.0

/**
 * #918 — "Edit link…" and "Replace image…" in the Live Edit preview.
 *
 * A link is editable when its `href` is a marked field (`data-caelo-fields`
 * carries `href=<path>`) and/or its text is a marked field. The editor
 * panel offers the text and the target (with the site's pages as
 * suggestions, sent by the editor as `caelo:page-paths`) and saves both
 * in one `caelo:field-edit`.
 *
 * An image is replaceable when its `src` is a marked field. The iframe
 * cannot show the media library, so it posts `caelo:image-replace` and the
 * editor opens its media picker, then saves the picked image (and its alt
 * text, when `alt` is a marked field the page shows nowhere else) as one
 * edit.
 *
 * Spliced into `INJECT_SCRIPT`'s closure; uses `attrFields`, `fieldAt`,
 * `saveEdits`, `chooseScope` and `edit` from `FIELD_EDIT_SCRIPT` and the
 * panel helpers from `EDIT_AFFORDANCES_SCRIPT`. ES5 in a template
 * literal: every backslash is doubled.
 */
export const LINK_IMAGE_EDIT_SCRIPT = `
  // The <a> around t whose target or text is a marked field, with both.
  function linkAt(t, moduleEl) {
    var a = t;
    while (a && a.nodeType === 1 && a !== moduleEl && a.tagName !== "A") a = a.parentNode;
    if (!a || a.tagName !== "A") return null;
    var marked = attrFields(a);
    var href = marked && marked.fields.href ? marked : null;
    var label = fieldAt(a, moduleEl);
    if (!href && !label) return null;
    return { a: a, href: href, label: label };
  }

  // The <img> t when its src is a marked field.
  function imageAt(t) {
    if (!t || t.tagName !== "IMG") return null;
    var marked = attrFields(t);
    return marked && marked.fields.src ? { img: t, marked: marked } : null;
  }

  function input(labelText, value, testid, listId) {
    var wrap = document.createElement("label");
    wrap.className = "field";
    var span = document.createElement("span");
    span.textContent = labelText;
    var el = document.createElement("input");
    el.type = "text";
    el.value = value;
    el.setAttribute("data-testid", testid);
    if (listId) el.setAttribute("list", listId);
    wrap.appendChild(span);
    wrap.appendChild(el);
    return { wrap: wrap, el: el };
  }

  function openLinkEditor(link, x, y) {
    var u = ensureUi();
    if (!u) return;
    state.mode = "dialog";
    showOutline(link.a);
    u.panel.className = "panel";
    u.panel.textContent = "";
    u.panel.setAttribute("role", "dialog");
    u.panel.setAttribute("data-testid", "caelo-link-editor");
    u.panel.appendChild(caption("Edit link"));
    var at = link.href ? link.href.at : { blockName: link.label.blockName, position: link.label.position };
    var shared = link.href ? link.href.shared : link.label.shared;
    // The text only counts when it belongs to the same placement as the target.
    var label =
      link.label && link.label.blockName === at.blockName && link.label.position === at.position
        ? link.label
        : null;
    var originalText = label ? link.a.textContent.replace(/\\s+/g, " ").trim() : "";
    var originalHref = link.href ? link.a.getAttribute("href") || "" : "";
    var textInput = label ? input("Text", originalText, "caelo-link-text") : null;
    var listId = "caelo-page-paths";
    var hrefInput = link.href ? input("Goes to", originalHref, "caelo-link-href", listId) : null;
    if (hrefInput) {
      var list = document.createElement("datalist");
      list.id = listId;
      pagePaths.forEach(function (p) {
        var o = document.createElement("option");
        o.value = p.path;
        o.textContent = p.title;
        list.appendChild(o);
      });
      u.panel.appendChild(list);
    }
    if (textInput) u.panel.appendChild(textInput.wrap);
    if (hrefInput) u.panel.appendChild(hrefInput.wrap);
    function save() {
      var edits = [];
      if (textInput && textInput.el.value.trim() !== originalText) {
        edits.push(edit(label, textInput.el.value.trim()));
      }
      if (hrefInput && hrefInput.el.value.trim() !== originalHref) {
        edits.push(edit(link.href.fields.href, hrefInput.el.value.trim()));
      }
      close();
      if (edits.length > 0) saveEdits(at, edits, shared, pointRect(x, y), function () {});
    }
    [textInput, hrefInput].forEach(function (i) {
      if (!i) return;
      i.el.addEventListener("keydown", function (ev) {
        ev.stopPropagation();
        if (ev.key === "Enter") {
          ev.preventDefault();
          save();
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          close();
        }
      });
    });
    var row = document.createElement("div");
    row.className = "actions";
    row.appendChild(button("Save", "caelo-link-save", save));
    u.panel.appendChild(row);
    place(pointRect(x, y), false);
    (textInput || hrefInput).el.focus();
  }

  // Whether the placement shows this field as visible text somewhere: then
  // an image's alt text must not overwrite it (alt="{{title}}" next to
  // <h1>{{title}}</h1> would rename the heading).
  function shownAsText(moduleEl, at, path) {
    if (!moduleEl || !document.createTreeWalker) return false;
    var walker = document.createTreeWalker(moduleEl, SHOW_COMMENT);
    var c;
    while ((c = walker.nextNode())) {
      var m = MARKER.exec(c.data.trim());
      if (!m) continue;
      var a = placementOf(m[1]);
      var p = parsePath(m[3]);
      if (a.blockName === at.blockName && a.position === at.position && p.field === path.field && p.index === path.index) {
        return true;
      }
    }
    return false;
  }

  function requestImageReplace(image, moduleEl, x, y) {
    var marked = image.marked;
    chooseScope(
      marked.shared,
      pointRect(x, y),
      function (scope) {
        var ctx = window.__caelo || {};
        var msg = {
          kind: "caelo:image-replace",
          pageId: ctx.pageId || "",
          blockName: marked.at.blockName,
          position: marked.at.position,
          src: edit(marked.fields.src, ""),
        };
        var alt = marked.fields.alt;
        if (alt && !shownAsText(moduleEl, marked.at, alt)) msg.alt = edit(alt, "");
        if (scope) msg.scope = scope;
        postToEditor(msg);
      },
      function () {},
    );
  }
`;
