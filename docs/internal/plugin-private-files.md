# Private plugin files

`private_files` grants an authenticated author workflow access to immutable,
plugin-scoped files. External packages need a separate Owner receipt bound to
that exact artifact, just like `cms_admin_schema`. The same SDK handle is
available to release-signed plugins with the declaration and an authenticated
author context. Visitors and static rendering never receive it.

The host stores bytes in forced-RLS tables in `cms_admin`; they are not public
media and are never included in media manifests or CDN uploads. Each SDK call
checks the active installation and current author `content.write` permission.
External calls also recheck the exact approved artifact and receipt IDs. File
writes commit under the same registry lock as authorization, so revocation
serializes against them. The plugin sees neither host paths nor credentials.

## SDK contract

`ctx.privateFiles` exposes `begin`, `writeChunk`, `commit`, `stat`, `readChunk`
and `remove`. Choose a UUID and SHA-256 before `begin`, together with `mediaType`
and `sizeBytes`. Send canonical base64 in 262144-byte chunks at aligned offsets;
only the final chunk may be shorter. The maximum file size is 20 MiB and the
per-plugin reserved byte quota is 1 GiB, counting unfinished uploads too. Quota
reservations and writes serialize per plugin. These bounds keep requests within
the existing Deno RPC limits; there is no unbounded binary IPC exception.

Repeating the same begin or chunk is idempotent; conflicting metadata or bytes
are rejected. `commit` requires every byte and verifies SHA-256. Pending uploads
cannot be read. A process restart preserves chunks and completed files. Resume
by repeating the same upload identity and chunks, then commit.

A ready identity never changes bytes. `remove({id, sha256})` releases the stored
bytes and quota but retains a tombstone, so an old immutable reference can never
silently point to different content. The plugin owns its reference retention
policy and must remove only files it no longer needs. Incorrect or abandoned
uploads can be removed the same way. There is no automatic expiry of originals.

## Private previews and downloads

The generic download route is `/plugins/<slug>/files/<id>/<sha256>`. It requires
an authenticated author and the current file grant. Bytes stream as an
`application/octet-stream` attachment with `no-store`, `nosniff` and a restrictive
CSP; the route never serves plugin bytes as same-origin executable HTML. Every
chunk read rechecks access. A revoked grant interrupts subsequent reads.

For preview images, a plugin returns `<img src="caelo-file:UUID:SHA256">` in its
existing `preview` HTML. The host resolves only files owned by that plugin,
decodes PNG/JPEG/WebP, rejects animated or non-raster content, and embeds WebP
thumbnails. There are at most 80 distinct images, 40 million decoded pixels per
source, a 1200×1200 thumbnail bound and an 8 MiB total thumbnail byte bound.
The preview keeps its opaque-origin CSP sandbox and allows no network requests.
Story text stays independent HTML; no text is rendered into the stored original
or preview thumbnail by this service. The original bytes remain unchanged.

Preview SDK contexts expose file reads only. Upload, commit and removal are
explicitly denied on preview GETs. Invalid or missing referenced images fail the
preview instead of substituting another version.

This is general file storage and display infrastructure. Provider calls, pricing
and durable media requests are separate services; book jobs and PDF generation
belong to their plugins. This change does not itself generate images or PDFs.
