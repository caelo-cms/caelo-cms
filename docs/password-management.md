<!-- SPDX-License-Identifier: MPL-2.0 -->

# Password management

Caelo accounts authenticate with an email + password (hashed with argon2id). This
page covers the three recovery / rotation paths and the strength policy that
applies to every one of them.

## Strength policy

Enforced in one place — `validatePasswordStrength` (`packages/admin-core/src/password.ts`)
— and applied at **every** point a password is set: first-owner setup, owner
creating a user, self-service change, self-service reset, and owner reset. The
policy follows NIST 800-63B (length + breach/common-list, not composition rules):

- at least **10 characters** (`MIN_PASSWORD_LENGTH`);
- not a **known-common / breached** password (built-in blocklist);
- not a **single repeated character** (`aaaaaaaaaa`) or a **pure keyboard/number
  sequence** (`1234567890`, `qwertyuiop`);
- must **not embed your own email local-part or display name** (tokens ≥ 4 chars).

A rejected password returns a structured reason that the UI shows verbatim, e.g.
*"That password is too common — pick something less guessable."*

## Change your own password

Signed-in users open **Account** (`/account`) and enter their current password +
a new one. The current password is verified first; on success the change also
**signs the account out of its other devices** (the current session stays live).

Op: `users.change_password` (human actor — RLS lets an actor mutate only its own row).

## Forgot your password (self-service reset)

1. On `/login`, click **"Forgot your password?"** → `/forgot`.
2. Enter your email. The response is always the same *"if an account exists, a
   reset link is on its way"* — Caelo never reveals whether an address has an
   account (no enumeration), and the endpoint is IP-rate-limited.
3. If an account exists, a link to `/reset?token=…` is emailed. The token is
   single-use and **expires in one hour**; only its SHA-256 hash is stored.
4. `/reset` sets the new password, **burns the token**, and **revokes all of the
   account's sessions** (the account may have been compromised). You're bounced
   to `/login` to sign in with the new password.

Ops: `auth.request_password_reset` → `auth.reset_password` (both system-context,
since the requester is unauthenticated). The reset email is sent **outside** the
DB transaction by `deliverPasswordResetEmail`.

### No mail transport configured? (dev)

When no email transport is set up (`/security/email`, default `none` in dev), the
reset link is **logged to stderr** instead of emailed:

```
[password-reset] no email transport configured — reset link for you@example.com: http://localhost:5173/reset?token=…
```

so the flow is fully exercisable locally. Configure a real transport (Resend) at
`/security/email` for production delivery.

## Owner reset (no email needed)

An owner (permission `users.manage`) can set another user's password directly from
**Security → Users** (`/security/users`) — the recovery path for a locked-out
teammate on an install with no mail transport. It also revokes that user's
sessions so they must sign in with the new password.

Op: `users.admin_set_password`. It runs in a **system-elevated** context (owner id
preserved for the audit trail): `users`/`sessions` are self-or-system under RLS,
so a bare human owner can't mutate another user's rows — the elevation is what
clears RLS, the same way first-owner setup runs as system.

> A sole owner who is locked out cannot use owner-reset (there's no one else to
> click it) — the **self-service email reset** is their path back in. In dev,
> `bun run --filter @caelo-cms/admin seed:dev` also resets the dev owner's
> password.

## Storage

`password_reset_tokens` (migration `0175`) holds one row per outstanding request:
the token **hash** (never the raw token), an `expires_at`, and a `used_at` that
makes it one-shot. RLS mirrors `sessions` (self-or-system), and a completed reset
supersedes every other outstanding token for the user.
