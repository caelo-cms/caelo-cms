# Database TLS: verify-full on every provider

Issue #1338 (gateway hardening L6, epic #763).

Every Caelo process that reaches a database on another machine connects
with `sslmode=verify-full`. The client checks that the server certificate
chains to a CA the install trusts and that it names the host the client
dialled. `sslmode=require`, which every provider used before, encrypts the
connection but checks neither, so anyone who can answer on the database's
address could read the passwords.

## The rule

`databaseUrlFromEnv` (packages/shared `database-url.ts`) refuses a URL whose
host is not loopback and whose `sslmode` is weaker than `verify-full`
(`databaseTlsProblem`, `database-tls.ts`). The error names the variable and
the fix. Loopback hosts and unix sockets stay exempt, so dev, CI and the
test suites keep connecting without TLS. No code path downgrades.

## Per provider

| Provider | Host the clients dial | Trust anchor (`sslrootcert`) | Server side |
|---|---|---|---|
| gcp, gcp-firebase | the instance's private DNS name (`dnsNames`, `PRIVATE_SERVICES_ACCESS`, `….sql-psa.goog`) | Google's Cloud SQL shared-CA bundle, `/etc/caelo/db-ca/cloudsql-global.pem` | `serverCaMode: GOOGLE_MANAGED_CAS_CA`, `sslMode: ENCRYPTED_ONLY`; a private Cloud DNS zone (`caelo-<env>-pg-dns`) resolves the name to the private IP |
| self-hosted | `postgres` (the Compose service) | the install's own CA, `.caelo/postgres-tls/ca.crt`, mounted at `/etc/caelo/db-ca/self-hosted-ca.pem` | Postgres with `ssl=on` and a server certificate for `postgres` |
| aws | the RDS endpoint | Amazon's RDS bundle, `/etc/caelo/db-ca/aws-rds-global.pem` | `rds.force_ssl=1` |
| azure | the Flexible Server FQDN | none; the certificate chains to public roots Bun trusts | `require_secure_transport` (on by default) |

Why each provider looks like this:

- **Cloud SQL.** The default per-instance CA puts a host name in the server
  certificate only for Private Service Connect instances. The shared CA puts
  the instance's DNS name in it for every instance, but Cloud SQL does not
  resolve that name: the install creates the DNS record in a private zone in
  its VPC (docs.cloud.google.com/sql/docs/postgres/authorize-ssl and
  configure-ssl-instance). An IP address is never in the certificate, so
  `databaseUrls` refuses an IP host. The bundle is Google's published
  `cloudsql-ca-bundles/global.pem`, which holds the root and every regional
  CA, so a server-certificate rotation needs no change on the client.
- **Self-hosted.** No public CA issues a certificate for `postgres`. The
  installer makes an ECDSA P-256 CA once and a server certificate it signs
  (`self-hosted-db-tls.ts`, `node:crypto` and a small DER encoder, so neither
  openssl nor a new dependency is needed). Postgres refuses a key file it
  does not own, and a bind mount keeps the host's owner, so the Postgres
  entrypoint first copies the key pair to a path the `postgres` user owns.
  The server certificate is renewed from the stored CA key one year before
  it ends. The CA itself is never replaced.
- **aws / azure.** Both stacks build verify-full URLs. They do not run Caelo
  services yet (#749, #750), so these URLs reach no container today.

## The bundles in the images

The CA bundles live in `packages/shared/certs/` and are copied to
`/etc/caelo/db-ca/` in every image that opens database connections: admin,
gateway and caelo-ops (`scripts/dockerfile-db-ca.test.ts`). The path is
fixed because a URL is often built somewhere else: on the operator's
machine, or by the admin for a job. `database-tls.test.ts` fails two years
before any certificate in a bundle expires. Refresh a bundle from its
provider's URL in the `database-tls.ts` file comment.

## Upgrades

- **gcp / gcp-firebase.** This is infrastructure contract 15
  (`infra-contract.ts`), so the in-cloud upgrader refuses to roll an install
  that has not converged. The converge's database TLS step
  (`cloudsql-tls.ts`, run before the migrations) works in this order:
  1. It patches the instance to the shared CA and encrypted-only.
  2. It creates a server certificate from the shared CA and rotates onto it.
     Open connections drop and reconnect.
  3. It creates the private zone and its A record.
  4. It moves the live database URLs of both services from the IP to the
     DNS name, keeping their `sslmode` so the running image keeps working.

  The roll then sets the verify-full URLs together with the image that
  carries the bundle. Every job that takes its database host from the
  admin's URL (migrations, upgrader, operator access) follows. A plan that
  still dials the IP refuses to roll (`databaseHostPending`). The installer
  adopts the zone and the record that an upgrade created
  (`adopt-existing.ts`).
- **The converge job on an install that still dials the IP (#1373).** The
  job writes the update timeline through its own database connection, so
  it cannot wait for the TLS step to give it a DNS name: a failure of the
  step would then reach only the job's log. It opens its queue on the IP
  the services dial (`converge-db-trust.ts`) and runs the TLS step as a
  timeline step of stage 2, under the state lock (`converge-job.ts`
  `secureDatabase`); then it reconnects on the DNS name with verify-full.
  The connection to the IP still authenticates the server, because the
  job's password is the provisioner's access token: the chain must end in
  the instance's own server CA (per-instance CA), or in the shared-CA
  bundle with a certificate fingerprint the Cloud SQL Admin API lists for
  the instance (shared CA). Both come from the Admin API, never from the
  network. `sslmode=require` is never used. When the step fails, the job
  reads the target again (the step may have rotated the certificate) and
  records the error and the request's end. If that read fails, it keeps the
  connection it has.

  Stage 1 runs the *installed* release's job code, which this cannot change
  after the fact. From this release on, stage 1 only reads where to connect
  and never runs the TLS step. For the one upgrade onto this release:
  - **v0.11.9 and older.** Stage 1 has no TLS step and connects to the IP
    the old way. It hands over to this release's stage 2, which runs the
    step as a timeline step.
  - **v0.11.10.** Stage 1 runs the TLS step before it opens its queue. An
    install that runs v0.11.10 has finished that converge and dials the DNS
    name, so the step returns at once. An install whose v0.11.10 converge
    failed (the job then points at v0.11.10's image) re-runs the step when
    the update is continued. The failure seen on searchviu-website
    ("reports no PRIVATE_SERVICES_ACCESS DNS name") cannot happen on that
    re-run: the instance already uses the shared CA, so the first describe
    already names the DNS host (the cause fixed in #1372). Any other failure
    of that step is still visible only in the job's log, once, until the
    install has moved past v0.11.10.
- **self-hosted.** `cms-provision up` and `upgrade` create the TLS files
  (`.caelo/postgres-tls/`). After pulling, the upgrade first recreates
  Postgres with TLS. The old containers keep connecting without TLS until
  they roll; Postgres still accepts those connections. It then applies
  public_role's limits and runs the migrations.

## Not yet

- Self-hosted Postgres still accepts connections without TLS (`host`, not
  `hostssl`, in `pg_hba.conf`), so the containers of the previous release
  keep working during an upgrade. Every Caelo client refuses anything less
  than verify-full. Making the server refuse them too is a follow-up for the
  release after this one.
