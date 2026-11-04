# Firebase Hosting in front of the gateway: measured behaviour (gcp-firebase)

What Firebase Hosting does to a request on its way to a Cloud Run rewrite target, measured on 2026-11-02 in the project of the live caelo-cms.com install (`caelo-gcp-firebase`, region `europe-west1`, release 0.11.5) for issue #1325 (gateway hardening P0, epic #763). Read this before you change `apps/api-gateway/src/client-ip.ts`, the per-provider hop counts in `packages/provisioning/src/stack-contract.ts` (`GATEWAY_TRUSTED_PROXY_HOPS`), a cookie the gateway reads, or how staging reaches the gateway (E13).

## Method

The live gateway was not changed. Visitor IPs, cookies and tokens are redacted below: `2001:db8::7` (IPv6) and `198.51.100.7` (IPv4) stand for the tester's own addresses. Google front-end addresses are kept, because they are infrastructure, not visitors.

1. **A temporary echo set-up in the same project:** a Cloud Run service `caelo-p0-tmp-echo` (the gateway's own release image, with its command replaced by a 1-line Bun server that returns the request's headers as JSON and can sleep `?delay=<ms>`), publicly invokable, and a second Hosting site `caelo-p0-tmp-echo` whose release rewrote `/api/**` and `**` to it. Both were deleted after the test; afterwards `gcloud run services list` showed only the production admin and gateway, and the Hosting sites list showed only the two sites that existed before.
2. **Read-only checks on live:** the gateway's Cloud Run service and revision config (`gcloud run services describe`, Run v2 API), the live Hosting release config (Hosting REST API `sites/<site>/releases`), two GET requests to the live site's `/api/…` paths, and the gateway's Cloud Run request logs since 2026-10-26 (`httpRequest.remoteIp`).
3. Official docs, cited where they apply.

The live site's rewrite is `{"glob": "/api/**", "run": {"serviceId": "caelo-production-gateway-eed8d4c", "region": "europe-west1"}}`; the test site used the same shape.

## 1. Cookies: only `__session` arrives (M11 confirmed)

Request through the rewrite (`curl https://caelo-p0-tmp-echo.web.app/api/t1?setcookie=1`):

```
> Cookie: __session=s1; caelo_visitor_id=v1; caelo_session=c1; caelo_consent=k1; other=o1
< (echoed at Cloud Run)  "cookie": "__session=s1"
```

The same request straight to the service's `*.run.app` URL arrived with all five cookies. A `Set-Cookie` the service sends (`p0tmp=1; Path=/; HttpOnly; Secure; SameSite=Lax`) reaches the browser unchanged, so cookies can be **set** through the rewrite but are never **sent back** except `__session`. Firebase also adds `Vary: cookie,need-authorization` to the response (seen on live `/api/_caelo/health` too).

Docs: "cookies are generally stripped from incoming requests … Only the specially-named `__session` cookie is permitted to pass through to the execution of your app." (<https://firebase.google.com/docs/hosting/manage-cache#using_cookies>)

What followed on gcp-firebase up to release 0.11.5, for every request that came through `/api/**`:

- `caelo_consent` (consent-manager) never reached the gateway. `resolveVisitor` (`apps/api-gateway/src/visitor.ts`) read consent from that cookie, so the `visitor_id` purpose never counted as granted.
- `caelo_visitor_id` was therefore never minted, and if the browser held one it would not have arrived anyway. `ctx.visitor.id` was always null for plugins.
- `caelo_session` (visitor login) was set by the gateway but never came back: a visitor could not stay logged in.
- The MCP consent cookie (`__Host-caelo-mcp-consent-*`) is unaffected: remote MCP talks to the gateway's `*.run.app` URL directly.

Fixed in #1343, the same way on every provider: the gateway reads exactly one cookie, `__session`, a container whose `vid` and `login` entries hold the signed visitor id and visitor session; the consent decision travels in the `x-caelo-consent` request header the consent runtime and the component kit send. See [`../visitor-privacy.md`](../visitor-privacy.md). Anything else that must reach the gateway from the browser has to be an entry of that container (the staging gate's session, E13 (a), has the reserved key `staging`) or a request header.

## 2. Client address: what the gateway sees

Request through the rewrite, IPv4, with forged headers:

```
> X-Forwarded-For: 6.6.6.6, 5.5.5.5
> Fastly-Client-IP: 8.8.4.4
> Forwarded: for=9.9.9.9
< "x-forwarded-for":  "198.51.100.7,142.250.32.168"
< "fastly-client-ip": "198.51.100.7"
< "fastly-temp-xff":  "6.6.6.6, 5.5.5.5, 198.51.100.7, 198.51.100.7"
< "forwarded":        "for=9.9.9.9,for=\"142.250.32.168\";proto=https"
< "x-forwarded-host": "caelo-p0-tmp-echo.web.app"
< "host":             "caelo-p0-tmp-echo-jegzejlvta-ew.a.run.app"
< "via":              "1.1 Firebase Hosting"
```

Three requests in a row gave `142.250.32.168`, `142.250.32.38` and `142.250.32.166` as the last entry. Over IPv6 it was `66.249.93.5`. A client `X-Real-IP` was passed through unchanged.

Direct to `*.run.app` with `X-Forwarded-For: 6.6.6.6`:

```
< "x-forwarded-for": "6.6.6.6,2001:db8::7"
```

So:

- **Firebase replaces** `X-Forwarded-For` with exactly the visitor's address (the client's entries move to `Fastly-Temp-XFF`) and overwrites `Fastly-Client-IP`. Cloud Run's front end then **appends** the address it got the connection from, which on the rewrite path is a Google front-end proxy (`66.249.x`, `142.250.x`, `192.178.x`, `74.125.x`, `66.102.x`, `2600:…` in the logs).
- The gateway runs with `CAELO_TRUSTED_PROXY_HOPS=1` and takes the **last** entry: the Google proxy, not the visitor and not a stable "edge" either. It changes from request to request.
- Live evidence: in the gateway's Cloud Run request logs since 2026-10-26, the 130 requests with the `*.run.app` host (the rewrite sets `Host` to the service URL) came from **100 distinct** remote addresses, practically all in Google front-end ranges (`66.249`, `142.250`, `192.178`, `74.125`, `66.102`). Rate-limit buckets on gcp-firebase are therefore close to one bucket per request: they neither stop one abuser nor reliably lock out real visitors. The earlier note "coarse, but not rotatable" in `client-ip.ts` was wrong; it is corrected in this change.
- `hops=2` is **not** a fix: the gateway must stay invokable by `allUsers` (below), so a direct `*.run.app` request with a forged first entry would choose its own bucket.

Can the gateway be closed to everything but Hosting? No. With the `allUsers` invoker binding removed from the echo service, the rewrite answered **403** too, and the Firebase Hosting service agent (`service-<project-number>@gcp-sa-firebasehosting.iam.gserviceaccount.com`) does not exist in the project (`INVALID_ARGUMENT: Service account … does not exist`), so there is nothing to grant `run.invoker` to. Firebase's own setup tells you to "allow unauthenticated invocations" (<https://firebase.google.com/docs/hosting/cloud-run>). Firebase Hosting cannot add a secret request header either (its `headers` config sets response headers only).

### Recommendation for P1

- Keep `CAELO_TRUSTED_PROXY_HOPS=1` on gcp-firebase. It is the only entry nobody can forge.
- Make **per-operation limits** (site-wide budgets per op, plus captcha/PoW on writes) the binding guard on gcp-firebase. Per-address buckets there are only a weak extra key.
- Optional finer key, if P1 wants one: use the second-to-last entry only when the last entry (added by Cloud Run, unforgeable) is in Google's own service ranges (`goog.json` minus `cloud.json`, <https://www.gstatic.com/ipranges/goog.json>, <https://www.gstatic.com/ipranges/cloud.json>); otherwise use the last entry. Residual risk: other Google services that egress from the same ranges and let a user set headers (for example Apps Script `UrlFetchApp`) could forge that entry. Not measured; a later test must check it before this rule is trusted for anything stronger than a rate-limit key, and never for the staging IP allowlist.

## 3. E13 (a): staging on a second Hosting site with a `**` rewrite

Measured on the test site, which is exactly this set-up:

| Question | Result |
|---|---|
| Does `__session` arrive? | Yes (`"cookie": "__session=s2"` on `/staging/page-N` through `**`). Every other cookie is stripped. |
| Does `Authorization: Basic …` arrive? | Yes, unchanged, on both `/api/**` and `**`. |
| Rewrite timeout | 60 s **to the first byte**. `?delay=59000` → 200 after 59.1 s. `?delay=65000`: GET → `503 first byte timeout` (Varnish error 54113) after **184.7 s**, and the service's request log shows **8** origin requests for that one GET (Firebase's edge and shield both retry). POST → `502` after 60.2 s with **one** origin request. Direct to `*.run.app` the same 65 s GET returned 200. |
| Host the service sees | `Host: <service>.run.app`; the requested host is in `X-Forwarded-Host` (and `X-Forwarded-Url`). |
| Client address | As in section 2: a rotating Google proxy. |

Docs: "Firebase Hosting is subject to a 60-second request timeout" (<https://firebase.google.com/docs/hosting/cloud-run>).

What P3b-2 must handle for (a):

- The staging gate's session cookie (`caelo_staging_access`, `packages/shared/src/staging-gate.ts`) must be named `__session` on that site. It is the only cookie the staging host can ever receive, so nothing else on the staging host may need a cookie of its own. Since #1343 `__session` is a container shared by several owners (`packages/shared/src/session-cookie.ts`): the gate's session goes in its reserved `staging` entry, and whoever writes the cookie keeps the other entries it received.
- #1330: the staging gateway gates every request whatever the host, so it does not look at `Host` or `X-Forwarded-Host` at all; it rewrites the build to the stored staging host.
- The gate's **IP allowlist mode cannot work behind the rewrite**: the only trustworthy address is a Google proxy, and any earlier entry is forgeable on `*.run.app`. On gcp-firebase under (a) the allowlist mode has to be refused (or replaced by the secret header), not silently kept.
- Staging responses are static files the staging gateway streams from the private staging bucket, so 60 s is enough. A file that does not start within 45 s answers 504: Firebase would replay a slower GET up to 8 times.

## 4. Cloud Run domain mappings: regions

"Domain mapping is available in the following regions: asia-east1, asia-northeast1, asia-southeast1, europe-north1, europe-west1, europe-west4, us-central1, us-east1, us-east4, us-west1." The install's region `europe-west1` is one of them. The same page marks the feature as **Preview**, "not production-ready" because of latency issues, and not recommended for production services (<https://docs.cloud.google.com/run/docs/mapping-custom-domains>). The fallback (b) would keep a staging set-up on a Preview feature that is unavailable for installs in other regions (for example `europe-west3`). (Hosting rewrites to Cloud Run are supported in a separate region list that includes `europe-west1`: <https://firebase.google.com/docs/hosting/cloud-run>.)

## 5. The gateway's Cloud Run settings (live)

From `gcloud run services describe caelo-production-gateway-eed8d4c` and the Run v2 API, revision `caelo-production-gateway-eed8d4c-00054-dcn`:

| Setting | Value |
|---|---|
| Execution environment | not set (`template.executionEnvironment` empty): Cloud Run picks it. The stack sets one only for the admin (media volume). |
| Ingress | `all` (since #650, for the staging domain mapping) |
| Invoker | `allUsers` (`gateway-public-invoker` in the stack) |
| Concurrency | 80 |
| Scaling | min 0, max 100 |
| CPU / memory | 1 vCPU, 512 MiB, CPU only during requests (`cpu-throttling: true`) |
| Request timeout | 3600 s (`GATEWAY_TIMEOUT_SECONDS`, for remote MCP on `*.run.app`); the rewrite still cuts at 60 s |
| `CAELO_TRUSTED_PROXY_HOPS` | 1 |
| VPC | Direct VPC egress, private ranges only |

## 6. Side check: staging `/api` on plain gcp (from code only)

Plain gcp has no staging host at all: `cms-provision staging-domain enable` refuses every provider but gcp-firebase (`packages/provisioning/src/cli.ts`, "#650 follow-up"), the URL map (`packages/provisioning/src/gcp-url-map.ts`) has host rules for `<domain>` and `admin.<domain>` only, and neither managed certificate covers a staging host. A request for a staging host that still reached the load balancer would fail TLS first; with TLS out of the way, an unmatched host goes to the map's `defaultService`, the public static bucket, which has no `api/` objects, so `/api/*` answers 404 (and `/` would serve the live site, not the staged one). So yes: 404, because staging is not wired up on plain gcp, not because a route refuses it.

## What a later controlled test should repeat

On a scratch install, not on live: the Apps Script / other-Google-egress forging question from section 2, and a streamed response that sends its first byte early and runs past 60 s (whether the 60 s limit is first-byte only for streams too).
