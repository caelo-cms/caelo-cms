# Visitor mail: the public outbox

How a public operation mails a visitor (a double opt-in, a sign-up verification, a password reset) without the public side holding a mail transport (issue #1337, epic #763 M7, E12). The auth core's use of it is #1334.

## The path

1. A plugin declares the mails it may send as `mailTemplates` in its manifest (plugin SDK `mail-templates.ts`): a subject, plain-text paragraphs and at most one link, whose target is one of its public write operations. The plugin also declares `requires: ["email"]` and the `email` capability; the manifest lint refuses templates without them.
2. The operation calls `ctx.email.queue({ template, to, token })`. On the public side that inserts one row into the public database's `mail_outbox` (cms_public migration 0610): the plugin id, the template name, the normalised recipient and the token. `ctx.email.send` refuses on the public side: there is no transport there. On the admin side `queue` writes to the live outbox and `send` uses the configured transport (an approved newsletter campaign).
3. The admin drains each public database's outbox on every scheduler tick (`core:mail-outbox`, admin-core `email/outbox.ts`): live, then staging. It renders the template, puts the link on the environment's own host and sends the mail with the transport configured at Settings → Email.
4. The link opens the gateway's confirmation page, `GET /api/_caelo/mail-link/<slug>/<operation>?token=…` (api-gateway `mail-link.ts`). Opening it changes nothing, because mail scanners open links. A click solves the operation's proof-of-work and calls `POST /api/plugin/<slug>/<operation>` with `{ token, …fields }`, an ordinary visitor call under every gateway rule (JSON only, the Origin rule, input schema, captcha, rate limits). The template may ask for password fields (the password reset).

## The outbox is attacker-writable

The public side is assumed compromised ([public-admin-boundary.md](./public-admin-boundary.md)). So:

- **The visitor role may only queue.** `INSERT` of the payload columns, nothing else: it cannot read the queue back, change or delete a row, or choose `id` or `created_at`. The policy admits a row only for a plugin in `published_plugins`. CHECKs bound every column: the template is a name, the recipient one address (no header injection), the token 16–128 of `[A-Za-z0-9_-]`.
- **A row chooses nothing a recipient reads.** The drain validates each row (`parseUntrustedRows`) and drops it unless a plugin this admin runs declares the template. Subject, text and link label come from that template as the admin loaded it. The link's origin comes from cms_admin: the site's base URL on live (`site_defaults.site_base_url`), the staging host on staging (`staging_access.staging_host`). The token only becomes the link's query.
- **Caps come from the admin's ledger.** Per environment, at most N mails per recipient in 24 hours and a site-wide number per hour on live and on staging. The drain counts rows of cms_admin `public_mail_deliveries` (migration 0610; the SHA-256 of the address, no address), which the public side cannot touch. The caps are the Owner's settings (`mail_delivery_caps`, migration 0611, seeded 5 / 200 / 50; Settings → Email): `mail_caps.set` is human-only, the AI proposes through the owner-settings gate (`propose_set_mail_caps` → `owner_settings.execute_proposal`, approver needs `settings.write`). The drain fails loudly if the row is missing; there is no default at read time.
- **Staging mails only the team.** Mail from the staging database's outbox goes only to addresses of cms_admin users; any other recipient is dropped and counted, never mailed (decision on #1330, moved to #1337).
- **Rows are short-lived and never lost.** A row older than 60 minutes is deleted unsent. A claimed row is leased to the drain (`claimed_until`, 10 minutes) and deleted when the drain is done with it (`mail_outbox.complete`); a drain that dies mid-way leaves it to the next tick (at least once). A transport failure is recorded on the ledger row and not retried. A linking mail is refused before any cap slot is used when the environment has no link origin.
- **No address in a log.** The drain logs counts per environment and the transport's status code, never its error text (which may echo the recipient) and never an address (#763 M7).
- **The link proves the inbox and nothing else.** The confirmation page sends the mail's token as `token`; a template may not declare a field of that name, and the operation must require `token` and every field (manifest lint). The auth plugin's verification link also asks for the password chosen at that sign-up, so the inbox owner cannot be tricked into completing someone else's earlier sign-up of their address.

## No transport, no half-working plugin

- `plugins.activate` and `plugins.approve_capabilities` refuse a plugin that `requires: ["email"]` while the transport is `none`, naming the setup step.
- `email_config.set` refuses to switch the transport to `none` while such a plugin is active, naming it.
- If the transport breaks anyway (a revoked API key), queued mail waits and expires, and the `core:mail-outbox` task fails loudly on its scheduler row while mail is waiting.

## Unsubscribe links (mail the admin sends directly)

A newsletter campaign does not go through the outbox: the Owner approved its exact content and the admin's worker sends it with `ctx.email.send` (`send-runs.ts`). Its unsubscribe link has its own path (#1432).

- **Declared, not templated.** A plugin declares `mailUnsubscribe: { operation, label, done }`, not a mail template, because a template could be queued from the attacker-writable outbox. The operation must be a public write that requires `token` and nothing else (manifest lint). The field is part of the public-surface snapshot, so the Owner sees it at approval.
- **The host makes the link.** `ctx.email.unsubscribeLink({ recipientId })` (admin side only) returns `<live origin>/api/_caelo/mail-link/<slug>/<operation>?token=…`. The origin is `site_defaults.site_base_url`, as for outbox links; without it the call throws. The newsletter asks for a batch's links before it claims the batch, so a site without a base URL fails the tick loudly and loses no recipient. Passing the link as `unsubscribeUrl` to `ctx.email.send` adds the `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers; a plugin never sets a mail header itself. Resend DKIM-signs what it sends, and RFC 8058 requires the signature to cover both headers, so check them in a received mail once per sending domain.
- **The token is signed and scoped.** `<recipient UUID>_<base64url HMAC-SHA256>` over plugin, operation and recipient (plugin-host `mail-link-token.ts`). The key is one row per public database (`mail_link_keys`, cms_public migration 0632), readable and not writable by the gateway role. It is not the gateway's cookie secret because that rotates, and a link in a sent mail must keep working: unsubscribe tokens do not expire. A compromised public side can read the key and forge an unsubscribe of a row in its own database, which it can write anyway.
- **Dispatch checks the signature on every visitor route.** `runPluginOperation` refuses the declared operation without a token the host signed, before the handler runs, so the plugin's handler only reads the recipient out of it (`mailUnsubscribeRecipient`). No entry point can skip it.
- **Two ways in, one operation.**
  - The link in the footer opens the confirmation page. Opening changes nothing, however often a mail scanner does it; the button solves the proof-of-work and calls the JSON route, like every other mail link.
  - The mail client's own button sends RFC 8058's `POST` to the same URL with the form body `List-Unsubscribe=One-Click`: no cookie, no Origin, no JSON, no proof-of-work. The gateway serves it only for a declared `mailUnsubscribe` operation and with exactly that body, so a scanner following links gets nowhere. It sets no cookie.
- **CLAUDE.md §7 on that POST.** A public write needs a CAPTCHA or proof-of-work, rate limits and a honeypot. One-click is a server-to-server call that can solve nothing, so the host-signed token stands in for the proof: it is stronger, since only the recipient of the mail has one, and a manifest alone cannot open the path. The rate limit is the operation's own, per recipient rather than per client address: a mailbox provider posts for all its users from few addresses, and a token cannot be minted to get a fresh budget. A junk POST costs one key read behind the per-client memory limiter and writes nothing. A honeypot has no meaning without a form.
- **Unsubscribing is idempotent.** A second press, or a subscriber who is gone, is a success: the signature already proved the link is real, and RFC 8058 clients treat an error as "still subscribed".

Every other mail a plugin sends goes through the outbox (the auth plugin's verification, reset and already-registered mails, the newsletter's double opt-in), so its link is absolute and opens the confirmation page already. They are transactional and carry no `List-Unsubscribe`. A campaign body's own root-relative `href` and `src` values get the same host when the mail is sent (`send-runs.ts`).

## The sending domain

A provider delivers for a domain only once its DNS says so (SPF, DKIM, a return-path MX). `email_config.sender_domain` (Settings → Email "Sending domain", the AI's `check_email_domain`) lists the records Resend asks for with their status, and with `verify` asks Resend to check again. Resend is the only implemented transport; its free plan sends 3,000 mails a month and 100 a day, its paid plans start at 50,000 a month (pricing checked 2026-11-04 at resend.com/pricing). The recommendation per provider (E12) is SES on aws and Communication Services on azure, which do not have transports yet.

## How this squares with the change journal

[state-and-changes.md](./state-and-changes.md) allows one mechanism for "what changed" in cms_admin, and no new outboxes there. The mail outbox is not such a mechanism: it lives in each public database (outside the journal, which covers cms_admin only), and it is an inbox of visitor requests, written by the public side and consumed once by the admin. The admin-side `public_mail_deliveries` is a ledger the caps count, exempt from the journal with that reason (`packages/shared/src/change-journal.ts`).

## Tests

- `packages/admin-core/src/__tests__/mail-outbox.integration.test.ts`: the visitor roles' privileges on both public databases, a forged row against template, host and caps, the site-wide cap, expiry, the staging team rule, the transport guard, the sending-domain records.
- `packages/plugin-sdk/src/mail-templates.test.ts`, `apps/api-gateway/src/mail-link.test.ts`: the manifest checks and the confirmation page.
- `apps/api-gateway/src/mail-unsubscribe.integration.test.ts`: a link from the admin's mail through the gateway with its real identity: the headers, opening changes nothing, one-click in both encodings, forged and transplanted tokens, the budget per recipient, the proof-of-work still required of a browser call, the key's privileges on both public databases.
