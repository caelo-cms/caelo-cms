// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { createServer, get } from "node:https";
import { createLoopbackTls } from "../loopback-tls.js";

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
