---
path: /docs/admin/passwords/
title: "Passwords"
description: "Password rules for Caelo accounts, how to change your password, reset a forgotten one, and how an Owner resets a teammate's."
---

# Passwords

You sign in to the Caelo admin with your email and a password. Caelo stores only a hash of it (argon2id).

## What a password must be

The same rules apply wherever a password is set: Owner setup, a new user, a change, a reset. They follow NIST 800-63B (length and known-bad lists, no composition rules):

- at least **10 characters**;
- not a **common or breached** password;
- not a **single repeated character** (`aaaaaaaaaa`) or a **plain keyboard or number sequence** (`1234567890`, `qwertyuiop`);
- not **containing your own email name or display name**.

When a password is refused, the form says why, for example *"That password is too common — pick something less guessable."*

## Change your own password

Open **Account** (`/account`), enter your current password and the new one. Changing it also **signs you out on your other devices**; the session you are using stays signed in.

## Forgot your password

1. On the sign-in page, click **Forgot your password?**
2. Enter your email. The answer is always the same, *"if an account exists, a reset link is on its way"*: Caelo never reveals whether an address has an account. Requests are rate-limited.
3. If the account exists, you get an email with a reset link. It works **once**, for **one hour**.
4. Set the new password. The link stops working, and **every session of the account is signed out** (in case someone else had access). Sign in with the new password.

The email needs a mail transport: set one up at **Settings → Email** (`/settings/email`). Without one, no reset email is sent; the link is only written to the admin's server log.

## Reset a teammate's password (Owner)

An Owner can set another user's password directly in **Settings → Users** (`/settings/users`). That is the way back in for a locked-out teammate on an install without a mail transport. It also signs that user out everywhere, so they sign in with the new password.

A sole Owner who is locked out has no one to do this. Their way back in is the **Forgot your password** email, or, on a `gcp-firebase` install, the `owner-reset` command (see [Locked out of the admin](/docs/install/google-cloud/#locked-out-of-the-admin)).
