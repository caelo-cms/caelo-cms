---
slug: staging-access
template: doc-page
status: published
seo:
  title: Protected staging — Caelo CMS
  description: Staging lives at staging.<domain>, serves exactly what Publish live ships, and is closed to everyone you have not let in. How to open it, how crawlers get in, and what Publish live checks.
---

# Protected staging (staging.&lt;domain&gt;)

Every **Stage** builds your site exactly as **Publish live** will ship it and serves it at `https://staging.<domain>`. Staging is always `noindex` and closed to the public: only people and tools you let in can open it.

> Available on **gcp-firebase** installs. Self-hosted and `gcp` installs follow; until then they keep their current staging preview.

## What staging shows

- **The same artefacts and hosting behaviour as live** — redirects, response headers, cache rules, trailing-slash handling — with only the host swapped.
- **Its own host everywhere.** Canonical links, `sitemap.xml`, the `Sitemap:` line in `robots.txt`, `og:url`, `hreflang` and every other absolute link name `staging.<domain>`, so a crawl of staging stays on staging and is self-consistent.
- **Always `noindex`** — `X-Robots-Tag: noindex` on every response, `Disallow: /` in robots.txt.

## Publish live checks that live matches staging

Because staging carries its own host, Publish live does not copy the staged build: it rebuilds the same content with the live host and compares the two builds **file by file, with the host swapped back**. If anything else differs — a page was edited, added or removed after the Stage, a plugin or a setting changed — Publish live stops and names the first differing files. Stage again, check staging, then publish.

## Who can open staging

Open **Security → Staging access** in the admin. Any one enabled mode lets a request in:

| Mode | For | How |
|---|---|---|
| **Open staging** (on by default) | Admin users | The *Open staging* button (Staging access page) and every staging link in the admin sign you in for 12 hours — no password. Admin access ⇒ staging access. |
| **Basic auth** | Crawlers, tools | A generated password for the user name you choose. |
| **Secret header** | Crawlers, tools | A generated value sent in a request header (default `X-Caelo-Staging-Key`). |
| **IP allowlist** | Crawlers with a static egress IP | Addresses or CIDRs (IPv4/IPv6) let in without credentials. |

A request that passes none of them gets **401** with a basic-auth prompt (when basic auth is on) or **403** with a short page pointing to the admin.

The credentials are generated, never stored in readable form, and shown only to the Owner (settings.write). **Rotate** replaces one; everything that used the old value is locked out until it gets the new one. `cms-provision rotate-secret staging-gate-secret` replaces the key everything is derived from — every staging session and both credentials change at once.

The AI can read the staging URL and the enabled modes (`get_staging_access`) and propose changes (`propose_set_staging_access`, `propose_rotate_staging_credentials`); each change waits for your Approve in the chat. It sees the credentials only when an Owner asks for them.

## Crawling staging (searchVIU)

Point the crawl at `https://staging.<domain>/` and give it one way in:

- **Basic auth:** enable it, then in the crawl profile set `dev_auth_type: "PW"`, `dev_auth_user` = the user name, `dev_auth_pw` = the generated password.
- **IP allowlist:** add the crawler's static egress IP, then set `dev_auth_type: "IP"`.
- **Secret header:** enable it and add the header to `additional_headers` (`{"X-Caelo-Staging-Key": "<value>"}`).

Always set `ignore_robots_tag_noindex: true` — staging is `noindex` by design.

## The quality check does not go through the gate

The Lighthouse check of a Stage loads the staged build directly, not through `staging.<domain>`: the gateway scales to zero, and its cold start would skew the performance score. Reports still name `staging.<domain>`.

## Setting it up (operator, once)

1. `cms-provision upgrade` — creates the staging gate key in Secret Manager and gives admin + gateway the staging host.
2. `cms-provision staging-domain enable` — maps `staging.<domain>` to the gateway (run as the Search Console owner of the domain, like `admin-domain enable`) and prints the DNS record to add, typically `CNAME staging → ghs.googlehosted.com.` TLS follows within 15–60 minutes of DNS resolving.
3. Stage once; *Open staging* takes you there.

## Residual risk on gcp-firebase

Firebase Hosting cannot put access control on a preview channel. The gateway proxies `staging.<domain>` to the **current** staged build's preview channel, whose own URL (`<site>--runid-….web.app`) therefore stays publicly reachable for anyone who learns it. Caelo never shows that URL, deletes older channels as soon as a newer Stage succeeds and the last one after Publish live, and every channel expires after 7 days. If staging must be truly private, use the `gcp` provider or a self-hosted install.
