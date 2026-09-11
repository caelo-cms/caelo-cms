# Private plugin previews

A plugin can declare a `preview` operation that returns `{html: string}`. Its
private URL is `/plugins/<slug>/preview?args=<URL-encoded JSON>`; args are capped
at 2048 characters and the returned HTML at 800,000 characters. Plugins return
these links from their authoring tools so the chat can show them to the author.
The host knows no books, pages or revisions. Domain rendering belongs to the
plugin; preview data can identify an immutable plugin-owned record.

Only authenticated authors with `content.write` can load a preview. External
plugins still need their exact installation receipts, including
`cms_admin_schema` for private storage. The host grants only public/private
storage `list` calls during preview execution. Writes, API calls, captcha,
providers and other elevated handles are unavailable. No caller-controlled
chat branch is supplied. An existing write tool cannot be invoked through GET.

The host removes active elements, hyperlinks, forms, SVG and external images.
A response-level opaque-origin CSP sandbox forbids scripts, navigation through
forms, network access and embedding by other origins. Only inline styling and
PNG/JPEG/WebP data images are supported. Responses are private (`no-store`),
including direct browser navigation, and revoked plugins no longer render.
Previously viewed content cannot be erased from an author's browser.

The renderer should escape all book text and place it in its own HTML elements.
These previews are not publication, printing approval or a PDF export service.
