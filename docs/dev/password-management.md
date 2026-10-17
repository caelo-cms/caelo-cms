<!-- SPDX-License-Identifier: MPL-2.0 -->

# Password management: implementation

How Caelo's account passwords are enforced, rotated and recovered in code. The
operator-facing page (rules, change, forgot, Owner reset) lives in the end-user
docs at [caelo-cms.com/docs](https://caelo-cms.com/docs/), "Passwords".

Accounts authenticate with email + password, hashed with argon2id.

## Strength policy

Enforced in one place, `validatePasswordStrength`
(`packages/admin-core/src/password.ts`), and applied at **every** point a password
is set: first-owner setup, owner creating a user, self-service change, self-service
reset, and owner reset. The policy follows NIST 800-63B (length + breach/common-list,
not composition rules):

- at least **10 characters** (`MIN_PASSWORD_LENGTH`);
- not a **known-common / breached** password (built-in blocklist);
- not a **single repeated character** or a **pure keyboard/number sequence**;
- must **not embed the account's own email local-part or display name** (tokens of 4+ chars).

A rejection returns a structured reason that the UI shows verbatim. A new path that
sets a password must call `validatePasswordStrength`; there is no second policy.

## Self-service change

Op: `users.change_password` (human actor; RLS lets an actor mutate only its own row).
It verifies the current password first; on success it revokes the account's other
sessions and keeps the current one.

## Self-service reset

Ops: `auth.request_password_reset` → `auth.reset_password`, both system-context
because the requester is unauthenticated.

- `/forgot` always answers the same way (no account enumeration) and is
  IP-rate-limited.
- The token is single-use, expires in one hour, and only its SHA-256 hash is stored.
- `/reset` sets the password, burns the token, and revokes **all** of the account's
  sessions.
- The email is sent **outside** the DB transaction by `deliverPasswordResetEmail`.

With no email transport configured (`/settings/email`, default `none` in dev), the
reset link is logged to stderr instead, so the flow is exercisable locally:

```
[password-reset] no email transport configured — reset link for you@example.com: http://localhost:5173/reset?token=…
```

## Owner reset

Op: `users.admin_set_password`, gated on `users.manage`. It runs in a
**system-elevated** context with the owner id preserved for the audit trail:
`users` / `sessions` are self-or-system under RLS, so a bare human owner cannot
mutate another user's rows. The elevation is what clears RLS, the same way
first-owner setup runs as system. It also revokes the target's sessions.

In dev, `bun run --filter @caelo-cms/admin seed:dev` resets the dev owner's password.

## Storage

`password_reset_tokens` (migration `0175`) holds one row per outstanding request:
the token **hash** (never the raw token), `expires_at`, and a `used_at` that makes
it one-shot. RLS mirrors `sessions` (self-or-system), and a completed reset
supersedes every other outstanding token for the user.
