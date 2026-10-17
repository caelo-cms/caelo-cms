---
slug: staging-access
template: doc-page
status: published
seo:
  title: Protected staging — Caelo CMS
  description: Staging lives on its own host (default staging.<domain>), serves exactly what Publish live ships, and is closed to everyone you have not let in. How to open it, how crawlers get in, and what Publish live checks.
---

# Protected staging

Every **Stage** builds your site exactly as **Publish live** will ship it and serves it on the **staging host** — `staging.<domain>` unless you chose another one. Staging is always `noindex` and closed to the public: only people and tools you let in can open it.

## The staging host

The staging host is a setting, not a fixed name. The install wizard asks for it (default `staging.<your domain>`; any host works, also one on another domain such as `preview.example.org`), non-interactive installs pass `--staging-domain <host>`, and installs from before the setting get `staging.<domain>` on their next `cms-provision upgrade`. The easiest way to change it is the command that also serves it: `cms-provision staging-domain enable --staging-domain <host>` sets the host in the admin for you (your running the command is the decision — it is audited), maps it and prints the DNS record. You can also change it under **Settings → Domains** (or ask the AI — `propose_set_staging_host`, which you approve in the chat); then run `cms-provision staging-domain enable` to map it — without `--staging-domain` the command maps whatever host the admin has stored. It must be a bare host name and must not be the live site's or the admin's host.

Which value wins: the host stored in the admin is the truth. `staging-domain enable --staging-domain <host>` and **Settings → Domains** change it; `cms-provision upgrade` never overwrites it (it only fills it in on installs that have none yet).

**A new host serves nothing until the next Stage.** Staging shows the last *staged* build, rendered for the host it was built with. After setting up or changing the host, Stage once (or let the AI call `stage_changes`). The command, Settings → Domains / Staging access and the AI's `get_staging_access` all say so when a Stage is missing.

**Draft pages are never staged.** Only pages with status *published* are built — for staging and for live. Every Stage result (the editor's toast, Open changes, the AI's `stage_changes`) lists the draft pages it left out; set them to published (the editor's status toggle, or the AI's `set_pages_status_many`) and Stage again.

> Available on **gcp-firebase** installs. Self-hosted and `gcp` installs follow; until then they keep their current staging preview.

## What staging shows

- **The same artefacts and hosting behaviour as live** — redirects, response headers, cache rules, trailing-slash handling — with only the host swapped.
- **Its own host everywhere.** Canonical links, `sitemap.xml`, the `Sitemap:` line in `robots.txt`, `og:url`, `hreflang` and every other absolute link name the staging host, so a crawl of staging stays on staging and is self-consistent.
- **Always `noindex`** — `X-Robots-Tag: noindex` on every response, `Disallow: /` in robots.txt.

## Publish live checks that live matches staging

Because staging carries its own host, Publish live does not copy the staged build: it rebuilds the same content with the live host and compares the two builds **file by file, with the host swapped back**. If anything else differs — a page was edited, added or removed after the Stage, a plugin or a setting changed — Publish live stops and names the first differing files. Stage again, check staging, then publish.

## Who can open staging

Open **Settings → Staging access** in the admin. Any one enabled mode lets a request in:

| Mode | For | How |
|---|---|---|
| **Open staging** (on by default) | Admin users | The *Open staging* button (Staging access page) and every staging link in the admin sign you in for 12 hours — no password. Admin access ⇒ staging access. |
| **Basic auth** | Crawlers, tools | A generated password for the user name you choose. |
| **Secret header** | Crawlers, tools | A generated value sent in a request header (default `X-Caelo-Staging-Key`). |
| **IP allowlist** | Crawlers with a static egress IP | Addresses or CIDRs (IPv4/IPv6) let in without credentials. |

A request that passes none of them gets **401** with a basic-auth prompt (when basic auth is on) or **403** with a short page pointing to the admin.

**Password protection is on from the start.** The first `cms-provision staging-domain enable` switches basic auth on with a user named after your site (e.g. `searchviu`) and a generated password, and prints both once — they are not saved anywhere on your machine. Change the user, add other modes or turn it off under Settings → Staging access; a basic auth you switched off stays off when you run the command again. `--rotate-staging-password` replaces the password and prints the new one, `--show-staging-password` prints the current one (both audited).

The credentials are generated, never stored in readable form, and shown only to the Owner (settings.write). **Rotate** replaces one; everything that used the old value is locked out until it gets the new one. `cms-provision rotate-secret staging-gate-secret` replaces the key everything is derived from — every staging session and both credentials change at once.

The AI can read the staging URL and the enabled modes (`get_staging_access`) and propose changes (`propose_set_staging_access`, `propose_rotate_staging_credentials`, `propose_set_staging_host`); each change waits for your Approve in the chat. It sees the credentials only when an Owner asks for them — the same holds for an external agent on the [Power-MCP](/mcp) surface: `get_staging_access` with `includeCredentials: true` returns the basic-auth password only to an `admin` token whose user holds settings.write, and every reveal is audited (`staging_access.reveal_credentials`).

## Crawling staging (searchVIU)

Point the crawl at `https://<staging host>/` and give it one way in:

- **Basic auth:** enable it, then in the crawl profile set `dev_auth_type: "PW"`, `dev_auth_user` = the user name, `dev_auth_pw` = the generated password.
- **IP allowlist:** add the crawler's static egress IP, then set `dev_auth_type: "IP"`.
- **Secret header:** enable it and add the header to `additional_headers` (`{"X-Caelo-Staging-Key": "<value>"}`).

Always set `ignore_robots_tag_noindex: true` — staging is `noindex` by design.

## The quality check does not go through the gate

The Lighthouse check of a Stage loads the staged build directly, not through the staging host: the gateway scales to zero, and its cold start would skew the performance score. Reports still name the staging host.

## Setting it up (operator, once)

1. `cms-provision upgrade` — creates the staging gate key in Secret Manager and records the staging host (default `staging.<domain>`) for the admin.
2. `cms-provision staging-domain enable [--staging-domain <host>]` — maps the staging host to the gateway (run as the Search Console owner of the domain, like `admin-domain enable`), sets that host in the admin, turns on basic auth and prints the login once, and prints the DNS record to add, typically a `CNAME` to `ghs.googlehosted.com.` TLS follows within 15–60 minutes of DNS resolving. It reaches the admin through its IAP as the install's `caelo-mcp` service account (the same way the MCP server does), so your gcloud account must be one the admin lets in.
3. Stage once — until then the host has nothing to serve. *Open staging* takes you there.

## Residual risk on gcp-firebase

Firebase Hosting cannot put access control on a preview channel. The gateway proxies the staging host to the **current** staged build's preview channel, whose own URL (`<site>--runid-….web.app`) therefore stays publicly reachable for anyone who learns it. Caelo never shows that URL, deletes older channels as soon as a newer Stage succeeds and the last one after Publish live, and every channel expires after 7 days. If staging must be truly private, use the `gcp` provider or a self-hosted install.
