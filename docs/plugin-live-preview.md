# Plugin documents in Live Edit

Live Edit can display private plugin documents beside the author chat. A successful tool result containing a local `/plugins/<slug>/preview?args=...` URL opens that document automatically. Existing preview links open in the same workspace when clicked normally; the explicit “Open full preview” action remains available. The latest preview in a chat is restored on entry; the URL retains the selected document and view on reload. Website preview and publishing remain separate.

The plugin's read-only `preview` operation may return a `PluginPreviewDocument`:

```ts
{
  html: '<p data-caelo-preview-target="paragraph-one">Hello</p>',
  title: 'My document',
  views: [{ id: 'first', label: 'First page' }],
  viewId: 'first',
  targets: [{
    id: 'paragraph-one',
    label: 'First page · Text',
    reference: { documentId: '...', revisionId: '...', part: 'paragraph-one' }
  }]
}
```

When the author selects a view, the host invokes the same operation with `previewView` added to its arguments. The plugin validates that view and returns only its relevant HTML/targets. `{ html }`-only plugins remain supported. The SDK exports the document/target types; the shared schema bounds their fields and rejects duplicate IDs. Domain semantics, revisions, page ordering and rendering remain owned by the plugin.

The host removes scripts, event handlers, navigation and external resources as before. For the embedded editor only, it adds a host-owned, nonce-authorized selection script inside an opaque-origin `sandbox="allow-scripts"` iframe. It does not grant same-origin access. Only declared target attributes survive sanitization. Parent messages must originate from the exact iframe, carry the current random channel and name a declared target. Text and images remain private and access is rechecked by the normal plugin broker. Metadata uses the same authenticated read-only route and never bypasses capability checks.

Selecting a target attaches a visible, removable reference to the composer. The bounded `previewSelection` chat field carries the plugin slug, target label and exact plugin-owned references; it is persisted with the user message and reaches the provider as reference data. It is not an authorization token. Authoring tools must read the current draft and enforce their normal ownership and revision/conflict rules before applying changes. Automated chat nudges and approval resumes do not consume the author's selected reference.

Pictbook implements cover/page views and independent image/text targets. Successful open/save/restore/commit/image-application results return their exact preview URL; losing conflict candidates do not move the canvas. A saved edit updates the preview while retaining a stable selected page/element when it still exists. No book schemas or PDF behavior are added to Caelo core.

Validation includes bounded schemas and URL routing, sanitizer protection, persisted provider context, conflict behavior, and a Playwright run using a real private book: single-page display beside chat, click selection, outgoing reference identity, rejected parent-window spoofing, streamed revision following, reload persistence and anonymous metadata denial. The browser test intercepts the chat transport, so it does not invoke a provider or modify the book.
