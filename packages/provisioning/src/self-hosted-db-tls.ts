// SPDX-License-Identifier: MPL-2.0

/**
 * #1338 (gateway hardening L6) — verify-full TLS between the self-hosted
 * Compose services and their Postgres.
 *
 * The admin and the gateway reach Postgres over the Compose network as
 * `postgres:5432`. With `sslmode=verify-full` they need a server
 * certificate for exactly that host name, signed by a CA they trust. No
 * public CA issues a certificate for `postgres`, so every install makes its
 * own: an ECDSA P-256 CA, generated once and kept in `.caelo/postgres-tls/`
 * (like the install's other secrets in `.caelo/`), and a server certificate
 * it signs. The CA certificate is mounted read-only into the admin and the
 * gateway at shared `SELF_HOSTED_CA_FILE`; the server key only into
 * Postgres.
 *
 * Generated with `node:crypto` and a minimal DER encoder below, so an
 * install needs neither openssl on the host nor a new dependency (§3).
 * Postgres reads ECDSA keys; Bun's TLS verifies the chain and the host.
 *
 * Re-runs keep what exists (the CA never changes once made, so no client
 * ever needs a new trust anchor); a server certificate that is missing,
 * does not chain to the CA, does not name `postgres`, or expires within a
 * year is re-issued from the stored CA key.
 */

import {
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The directory under `.caelo/` that holds the install's database TLS files. */
export const SELF_HOSTED_TLS_DIR = "postgres-tls";

/** The host name the services dial Postgres by on the Compose network. */
export const SELF_HOSTED_DB_HOST = "postgres";

/** File names inside {@link SELF_HOSTED_TLS_DIR}. */
export const SELF_HOSTED_TLS_FILES = {
  caCert: "ca.crt",
  caKey: "ca.key",
  serverCert: "server.crt",
  serverKey: "server.key",
} as const;

const YEAR_MS = 365 * 24 * 3600 * 1000;
const CA_VALIDITY_YEARS = 30;
const SERVER_VALIDITY_YEARS = 10;
/** A server certificate closer than this to its end is re-issued. */
const RENEW_BEFORE_MS = YEAR_MS;

// ---------------------------------------------------------------------------
// Minimal DER (X.690) — only what an X.509 v3 certificate needs.
// ---------------------------------------------------------------------------

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, inner: Buffer) => tlv(0xa0 + n, inner);
const octets = (b: Buffer) => tlv(0x04, b);
/** A BIT STRING; `unused` trailing bits of the last byte (DER: minimal for named bits). */
const bitString = (b: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));

function integer(b: Buffer): Buffer {
  let v = b;
  while (v.length > 1 && v[0] === 0 && (v[1] ?? 0) < 0x80) v = v.subarray(1);
  if ((v[0] ?? 0) >= 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return tlv(0x02, v);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128))
      chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime until 2049, GeneralizedTime from 2050 (RFC 5280 §4.1.2.5). */
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return d.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`))
    : tlv(0x18, Buffer.from(`${iso}Z`));
}

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), utf8(cn))));
const extension = (id: string, critical: boolean, value: Buffer) =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

interface CertSpec {
  readonly subject: string;
  readonly issuer: string;
  readonly publicKey: KeyObject;
  readonly signingKey: KeyObject;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly ca: boolean;
  /** DNS subjectAltNames (server certificates). */
  readonly dnsNames?: readonly string[];
}

function certificatePem(spec: CertSpec): string {
  const spki = spec.publicKey.export({ type: "spki", format: "der" });
  const exts = [
    extension("2.5.29.19", true, spec.ca ? seq(bool(true)) : seq()),
    // keyCertSign + cRLSign for the CA; digitalSignature for the server.
    extension(
      "2.5.29.15",
      true,
      spec.ca ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7),
    ),
    ...(spec.ca
      ? []
      : [
          extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),
          extension(
            "2.5.29.17",
            false,
            seq(...(spec.dnsNames ?? []).map((n) => tlv(0x82, Buffer.from(n, "ascii")))),
          ),
        ]),
  ];
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    ECDSA_SHA256,
    name(spec.issuer),
    seq(time(spec.notBefore), time(spec.notAfter)),
    name(spec.subject),
    spki,
    explicit(3, seq(...exts)),
  );
  const signature = sign("sha256", tbs, { key: spec.signingKey, dsaEncoding: "der" });
  const der = seq(tbs, ECDSA_SHA256, bitString(signature));
  const b64 = der.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** The PEM files of an install's database TLS. */
export interface DatabaseTlsFiles {
  readonly caCert: string;
  readonly caKey: string;
  readonly serverCert: string;
  readonly serverKey: string;
}

function newKeyPair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

/** A server certificate for {@link SELF_HOSTED_DB_HOST}, signed by the CA. */
function issueServer(
  ca: { cert: string; key: KeyObject },
  now: Date,
): Pick<DatabaseTlsFiles, "serverCert" | "serverKey"> {
  const server = newKeyPair();
  const caSubject = new X509Certificate(ca.cert).subject.replace(/^CN=/, "");
  return {
    serverCert: certificatePem({
      subject: SELF_HOSTED_DB_HOST,
      issuer: caSubject,
      publicKey: server.publicKey,
      signingKey: ca.key,
      notBefore: new Date(now.getTime() - 3600 * 1000),
      notAfter: new Date(now.getTime() + SERVER_VALIDITY_YEARS * YEAR_MS),
      ca: false,
      dnsNames: [SELF_HOSTED_DB_HOST],
    }),
    serverKey: server.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** A fresh CA and a server certificate it signed. */
export function generateDatabaseTls(now: Date = new Date()): DatabaseTlsFiles {
  const ca = newKeyPair();
  const caCert = certificatePem({
    subject: "Caelo self-hosted database CA",
    issuer: "Caelo self-hosted database CA",
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
    notBefore: new Date(now.getTime() - 3600 * 1000),
    notAfter: new Date(now.getTime() + CA_VALIDITY_YEARS * YEAR_MS),
    ca: true,
  });
  return {
    caCert,
    caKey: ca.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ...issueServer({ cert: caCert, key: ca.privateKey }, now),
  };
}

/** Why `serverCert` must be re-issued, or null when it is fine. */
export function serverCertProblem(caCert: string, serverCert: string, now: Date): string | null {
  try {
    const ca = new X509Certificate(caCert);
    const server = new X509Certificate(serverCert);
    if (!server.verify(ca.publicKey)) return "it is not signed by the install's CA";
    if (server.checkHost(SELF_HOSTED_DB_HOST) !== SELF_HOSTED_DB_HOST) {
      return `it does not name ${SELF_HOSTED_DB_HOST}`;
    }
    if (Date.parse(server.validTo) - now.getTime() < RENEW_BEFORE_MS) {
      return `it expires ${server.validTo}`;
    }
    return null;
  } catch (e) {
    return `it does not parse (${e instanceof Error ? e.message : String(e)})`;
  }
}

/**
 * Make sure `<caeloDir>/postgres-tls/` holds the install's CA and a valid
 * server certificate; returns what it did (empty when nothing changed).
 * The CA is created once and never replaced.
 */
export function ensureSelfHostedDbTls(caeloDir: string, now: Date = new Date()): string[] {
  const dir = join(caeloDir, SELF_HOSTED_TLS_DIR);
  const path = (f: keyof typeof SELF_HOSTED_TLS_FILES) => join(dir, SELF_HOSTED_TLS_FILES[f]);
  // The CA key and the server key are secrets; the certificates are not,
  // but every container reads them through a bind mount, so 0644.
  const write = (f: keyof typeof SELF_HOSTED_TLS_FILES, content: string) =>
    writeFileSync(path(f), content, { mode: f.endsWith("Key") ? 0o600 : 0o644 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const done: string[] = [];
  if (!existsSync(path("caCert")) || !existsSync(path("caKey"))) {
    if (existsSync(path("caCert")) !== existsSync(path("caKey"))) {
      throw new Error(
        `${dir} holds only half of the database CA (${SELF_HOSTED_TLS_FILES.caCert} / ${SELF_HOSTED_TLS_FILES.caKey}). Restore the missing file from your backup of .caelo/, or delete both to make a new CA (every service is re-created with it on the next \`cms-provision up\`).`,
      );
    }
    const files = generateDatabaseTls(now);
    for (const f of Object.keys(SELF_HOSTED_TLS_FILES) as (keyof typeof SELF_HOSTED_TLS_FILES)[]) {
      write(f, files[f]);
    }
    done.push(
      `created the install's database CA and the server certificate for ${SELF_HOSTED_DB_HOST}`,
    );
    return done;
  }
  const caCert = readFileSync(path("caCert"), "utf8");
  const problem = existsSync(path("serverCert"))
    ? serverCertProblem(caCert, readFileSync(path("serverCert"), "utf8"), now)
    : "it is missing";
  if (problem === null && existsSync(path("serverKey"))) return done;
  const key = createPrivateKey(readFileSync(path("caKey"), "utf8"));
  const issued = issueServer({ cert: caCert, key }, now);
  write("serverCert", issued.serverCert);
  write("serverKey", issued.serverKey);
  done.push(`re-issued the database server certificate (${problem ?? "its key was missing"})`);
  return done;
}
