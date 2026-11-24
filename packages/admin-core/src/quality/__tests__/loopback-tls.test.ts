// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { createSecureServer } from "node:http2";
import { createServer, get } from "node:https";
import { createLoopbackTls, serialInteger } from "../loopback-tls.js";

describe("createLoopbackTls", () => {
  const now = new Date("2026-11-24T10:00:00Z");
  const tls = createLoopbackTls(now);
  const cert = new X509Certificate(tls.cert);

  it("is a self-signed certificate for 127.0.0.1, valid around the audit", () => {
    expect(cert.subject).toBe("CN=127.0.0.1");
    expect(cert.issuer).toBe("CN=127.0.0.1");
    expect(cert.subjectAltName).toBe("IP Address:127.0.0.1");
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(new Date(cert.validFrom).getTime()).toBe(now.getTime() - 60 * 60 * 1000);
    expect(new Date(cert.validTo).getTime()).toBe(now.getTime() + 24 * 60 * 60 * 1000);
  });

  it("names its own key as the browser's trust entry", () => {
    const spki = cert.publicKey.export({ type: "spki", format: "der" });
    expect(tls.spkiSha256).toBe(createHash("sha256").update(spki).digest("base64"));
  });

  it("encodes every serial as a positive, minimal DER INTEGER", () => {
    // 0x00 or 0x80 first: masking the sign bit alone left a leading zero
    // byte before 0x12, which BoringSSL refuses (INVALID_INTEGER).
    for (const first of [0x00, 0x80, 0x3f, 0xff]) {
      const random = new Uint8Array(16).fill(0x12);
      random[0] = first;
      const der = serialInteger(random);
      expect(der[0]).toBe(0x02);
      expect(der[1]).toBe(16);
      expect(der[2]).toBeGreaterThanOrEqual(0x40);
      expect(der[2]).toBeLessThan(0x80);
      expect([...der.slice(3)]).toEqual([...random.slice(1)]);
    }
  });

  it("starts a TLS server whatever the serial's random bytes (#1695 gate run)", async () => {
    for (const first of [0x00, 0x80]) {
      const random = new Uint8Array(16).fill(0x12);
      random[0] = first;
      const fresh = createLoopbackTls(now, random);
      expect(new X509Certificate(fresh.cert).serialNumber).toMatch(/^[4-7][0-9A-F]{31}$/);
      const server = createSecureServer({ key: fresh.key, cert: fresh.cert });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("is a fresh key every time", () => {
    expect(createLoopbackTls().spkiSha256).not.toBe(createLoopbackTls().spkiSha256);
  });

  it("passes a TLS client's full verification for 127.0.0.1 when trusted as its own CA", async () => {
    const fresh = createLoopbackTls();
    const server = createServer({ key: fresh.key, cert: fresh.cert }, (_req, res) => {
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        get({ host: "127.0.0.1", port, path: "/", ca: fresh.cert }, (res) => {
          let text = "";
          res.on("data", (c: Buffer) => {
            text += c.toString();
          });
          res.on("end", () => resolve(text));
        }).on("error", reject);
      });
      expect(body).toBe("ok");
    } finally {
      server.close();
    }
  });
});
