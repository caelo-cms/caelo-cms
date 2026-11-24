// SPDX-License-Identifier: MPL-2.0

/**
 * A throwaway TLS identity for one loopback origin of the Stage audit.
 *
 * Why the audit serves TLS at all: every host a visitor reaches (the CDN
 * in front of staging and live, Caddy on self-hosted) speaks HTTP/2, and
 * Chromium speaks HTTP/2 only over TLS. Lighthouse's simulation models
 * the connections the browser really opened: over HTTP/1.1 each parallel
 * request opens its own connection and pays its own handshake, over
 * HTTP/2 they share one. An HTTP/1.1 loopback origin therefore charges a
 * page connection costs no visitor pays: searchviu.com's home page scored
 * Performance 99 (simulated LCP 1.8 to 2.0 s) on HTTP/1.1 and 100
 * (1.5 s, every run) on HTTP/2 with the same files.
 *
 * Why a self-signed certificate is enough: the audit browser is told to
 * trust exactly this key (`--ignore-certificate-errors-spki-list`), and
 * no other certificate error is ignored. The key lives in memory for one
 * audit and is never written anywhere.
 *
 * Built from `node:crypto` only (an ECDSA P-256 key, the certificate's
 * DER assembled here): no dependency for about sixty lines of ASN.1.
 */

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/** The key, certificate and the browser's trust entry of one loopback origin. */
export interface LoopbackTls {
  /** PEM, PKCS#8. */
  readonly key: string;
  /** PEM, X.509 v3, self-signed, `127.0.0.1` as subject and IP SAN. */
  readonly cert: string;
  /** Base64 SHA-256 of the SubjectPublicKeyInfo: Chromium's SPKI-list entry. */
  readonly spkiSha256: string;
}

/** DER tag-length-value. */
function tlv(tag: number, content: Uint8Array): Uint8Array {
  const n = content.byteLength;
  const length =
    n < 0x80
      ? [n]
      : n < 0x100
        ? [0x81, n]
        : n < 0x10000
          ? [0x82, n >> 8, n & 0xff]
          : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return Buffer.concat([Uint8Array.of(tag, ...length), content]);
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, Buffer.concat(parts));

/** An OBJECT IDENTIFIER from its dotted form. */
function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]];
  const bytes = [a * 40 + b];
  for (const arc of rest) {
    const base128 = [arc & 0x7f];
    for (let v = arc >>> 7; v > 0; v >>>= 7) base128.unshift((v & 0x7f) | 0x80);
    bytes.push(...base128);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

/** UTCTime, `YYMMDDHHMMSSZ` (valid for 1950 to 2049, which covers any audit). */
function utcTime(at: Date): Uint8Array {
  const text = at.toISOString().replace(/[-:T]/g, "").slice(2, 14);
  return tlv(0x17, Buffer.from(`${text}Z`, "ascii"));
}

const ECDSA_WITH_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const NAME = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("127.0.0.1", "utf8")))));
/** subjectAltName with the one IP address `127.0.0.1` ([7] iPAddress). */
const SAN_LOOPBACK = seq(oid("2.5.29.17"), tlv(0x04, seq(tlv(0x87, Uint8Array.of(127, 0, 0, 1)))));

function pem(label: string, der: Uint8Array): string {
  const body = Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${body.replace(/\n$/, "")}\n-----END ${label}-----\n`;
}

/**
 * A fresh key and a certificate valid from an hour before `now` to a day
 * after it (an audit takes minutes; the hour absorbs a skewed clock).
 */
export function createLoopbackTls(now: Date = new Date()): LoopbackTls {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  // A positive serial: the high bit of the first byte is clear.
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Uint8Array.of(2))),
    tlv(0x02, serial),
    ECDSA_WITH_SHA256,
    NAME,
    seq(
      utcTime(new Date(now.getTime() - 60 * 60 * 1000)),
      utcTime(new Date(now.getTime() + 24 * 60 * 60 * 1000)),
    ),
    NAME,
    spki,
    tlv(0xa3, seq(SAN_LOOPBACK)),
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const certificate = seq(
    tbs,
    ECDSA_WITH_SHA256,
    tlv(0x03, Buffer.concat([Uint8Array.of(0), signature])),
  );
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: pem("CERTIFICATE", certificate),
    spkiSha256: createHash("sha256").update(spki).digest("base64"),
  };
}
