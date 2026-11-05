// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { emitCaddyStaticFileHeaders } from "./redirect-emit-caddy.js";
import { cacheControlForContentType, contentTypeFor, isSafeStagedPath } from "./staged-site.js";
import {
  formatStaticFilesManifest,
  parseStaticFilesManifest,
  STATIC_FILE_MAX_BYTES,
  staticFileBodyIssue,
  staticFileCollisions,
  staticFileContentTypeHeader,
  staticFileIssues,
  staticFilePathIssue,
  staticFileTypeIssue,
} from "./static-files.js";

describe("staticFilePathIssue", () => {
  it.each([
    "/bot/ips.json",
    "/ads.txt",
    "/llms.txt",
    "/data/export.csv",
    "/feed/items.xml",
    "/BingSiteAuth.xml",
    "/.well-known/security.txt",
    "/.well-known/assetlinks.json",
    "/.well-known/apple-app-site-association",
    "/.well-known/nested/thing.json",
    "/plain-name",
  ])("accepts %s", (path) => {
    expect(staticFilePathIssue(path)).toBeNull();
    expect(isSafeStagedPath(path.slice(1))).toBe(true);
  });

  it.each([
    ["no leading slash", "bot/ips.json"],
    ["a folder", "/bot/"],
    ["the root", "/"],
    ["the assets folder", "/_assets/x.json"],
    ["the platform folder", "/_caelo/x.json"],
    ["any underscore folder", "/_redirects"],
    ["Firebase's reserved folder", "/__/x.json"],
    ["the gateway", "/api/x.json"],
    ["the gateway, other case", "/API/x.json"],
    ["robots.txt", "/robots.txt"],
    ["robots.txt, other case", "/ROBOTS.txt"],
    ["the sitemap", "/sitemap.xml"],
    ["the routing manifest", "/routing-manifest.json"],
    ["a hidden file", "/.env"],
    ["a hidden folder", "/.git/config"],
    ["a hidden file below a folder", "/bot/.htaccess"],
    ["only the well-known folder", "/.well-known"],
    ["remote MCP's OAuth metadata", "/.well-known/oauth-protected-resource"],
    ["remote MCP's metadata, deeper", "/.well-known/oauth-authorization-server/api/mcp/oauth"],
    ["certificate issuance", "/.well-known/acme-challenge/token"],
    ["a traversal", "/bot/../robots.txt"],
    ["an empty segment", "/bot//ips.json"],
    ["a query", "/bot/ips.json?x=1"],
    ["a space", "/bot/my file.json"],
    ["HTML", "/verify.html"],
    ["an HTML variant", "/verify.HTM"],
    ["JavaScript", "/app.js"],
    ["an ES module", "/app.mjs"],
    ["CSS", "/site.css"],
    ["SVG", "/logo.svg"],
    ["an icon", "/favicon.ico"],
    ["a very long path", `/${"a".repeat(201)}`],
  ])("refuses %s", (_what, path) => {
    expect(staticFilePathIssue(path)).not.toBeNull();
  });
});

describe("staticFileTypeIssue", () => {
  it("takes the declared type where the extension agrees", () => {
    expect(staticFileTypeIssue("/a.json", "application/json")).toBeNull();
    expect(staticFileTypeIssue("/a.xml", "text/xml")).toBeNull();
    expect(staticFileTypeIssue("/a.xml", "application/xml")).toBeNull();
    expect(staticFileTypeIssue("/.well-known/x", "application/json")).toBeNull();
  });

  it("refuses a type the extension contradicts", () => {
    expect(staticFileTypeIssue("/a.json", "text/plain")).toContain("application/json");
  });

  it("refuses every type outside the allow-list, a path without extension included", () => {
    for (const type of ["text/html", "application/javascript", "text/css", "image/svg+xml"]) {
      expect(staticFileTypeIssue("/x", type)).toContain("cannot be served");
    }
  });
});

describe("staticFileBodyIssue", () => {
  it("accepts plain data", () => {
    expect(staticFileBodyIssue("application/json", '{"ips":["192.0.2.1"]}')).toBeNull();
    expect(staticFileBodyIssue("text/plain", "Contact: mailto:security@example.com\n")).toBeNull();
    expect(staticFileBodyIssue("text/csv", "a,b\n1,2\n")).toBeNull();
    expect(staticFileBodyIssue("application/xml", "<users><user>a</user></users>")).toBeNull();
  });

  it("refuses an empty file, invalid JSON and a NUL", () => {
    expect(staticFileBodyIssue("text/plain", "")).toContain("empty");
    expect(staticFileBodyIssue("application/json", "{oops")).toContain("not valid JSON");
    expect(staticFileBodyIssue("text/plain", "a\0b")).toContain("NUL");
  });

  it("counts bytes, not characters, against the cap", () => {
    expect(staticFileBodyIssue("text/plain", "a".repeat(STATIC_FILE_MAX_BYTES))).toBeNull();
    expect(staticFileBodyIssue("text/plain", "ä".repeat(STATIC_FILE_MAX_BYTES / 2 + 1))).toContain(
      "bytes",
    );
  });

  it.each([
    ["an XHTML script", '<a><script xmlns="http://www.w3.org/1999/xhtml">x()</script></a>'],
    ["an SVG", '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>'],
    ["MathML", '<math xmlns="http://www.w3.org/1998/Math/MathML"/>'],
    ["a stylesheet", '<?xml-stylesheet href="x.xsl" type="text/xsl"?><a/>'],
    ["a doctype", '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'],
    ["an escaped namespace", '<a xmlns:h="http&#58;//www.w3.org/1999/xhtml"><h:script/></a>'],
    ["single quotes", "<a xmlns:h='http&#58;//evil'><h:script/></a>"],
  ])("refuses XML with %s, as both XML types", (_what, body) => {
    expect(staticFileBodyIssue("application/xml", body)).toContain("run as a page");
    expect(staticFileBodyIssue("text/xml", body)).toContain("run as a page");
  });
});

describe("the escaped-namespace check", () => {
  it("takes a namespace without references, and an ampersand outside one", () => {
    const body = '<a xmlns="urn:x" xmlns:b="urn:y"><b:c>1 &amp; 2</b:c></a>';
    expect(staticFileBodyIssue("application/xml", body)).toBeNull();
  });

  it("finds spaces around the equals sign", () => {
    const body = '<a xmlns:h = "http&#58;//x"/>';
    expect(staticFileBodyIssue("text/xml", body)).toContain("run as a page");
  });

  it("stays fast on a body built to make it backtrack (CodeQL js/polynomial-redos)", () => {
    const started = performance.now();
    expect(staticFileBodyIssue("application/xml", "xmlns:".repeat(40_000))).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("staticFileCollisions", () => {
  const none = { pagePaths: [], redirectFromPaths: [], filePaths: [] };

  it("finds nothing on a free path", () => {
    expect(
      staticFileCollisions("/bot/ips.json", { ...none, pagePaths: ["/bot", "/bot/x"] }),
    ).toEqual([]);
  });

  it("finds a page at the path, with or without its trailing slash", () => {
    expect(staticFileCollisions("/about", { ...none, pagePaths: ["/about"] })).toHaveLength(1);
    expect(staticFileCollisions("/about", { ...none, pagePaths: ["/about/"] })).toHaveLength(1);
  });

  it("finds a page below an extension-less file", () => {
    expect(staticFileCollisions("/docs", { ...none, pagePaths: ["/docs/intro"] })).toEqual([
      "the page /docs/intro sits below /docs",
    ]);
  });

  it("finds a redirect from the path", () => {
    expect(
      staticFileCollisions("/old.json", { ...none, redirectFromPaths: ["/old.json"] }),
    ).toHaveLength(1);
  });

  it("finds a file that needs this path as a folder, and the reverse", () => {
    expect(staticFileCollisions("/a", { ...none, filePaths: ["/a/b.json"] })).toHaveLength(1);
    expect(staticFileCollisions("/a/b.json", { ...none, filePaths: ["/a"] })).toHaveLength(1);
  });

  it("does not count the file itself", () => {
    expect(staticFileCollisions("/a.json", { ...none, filePaths: ["/a.json"] })).toEqual([]);
  });
});

describe("staticFileIssues", () => {
  it("reports the path and the body together, so one fix round is enough", () => {
    const issues = staticFileIssues({
      path: "/x.html",
      contentType: "application/json",
      body: "{",
      purpose: "test",
    });
    expect(issues).toHaveLength(2);
  });
});

describe("how the files are served", () => {
  it("serves every allowed type with a UTF-8 charset", () => {
    expect(staticFileContentTypeHeader("application/json")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor("data/export.csv")).toBe("text/csv; charset=utf-8");
  });

  it("gives a text file five minutes, like robots.txt, and leaves the build's own files alone", () => {
    expect(cacheControlForContentType("text/plain; charset=utf-8", "ads.txt")).toBe(
      "public, max-age=300",
    );
    expect(cacheControlForContentType("text/csv; charset=utf-8", "a/b.csv")).toBe(
      "public, max-age=300",
    );
    expect(cacheControlForContentType("application/xml; charset=utf-8", "a.xml")).toBe(
      "public, max-age=300",
    );
    expect(cacheControlForContentType("application/json; charset=utf-8", "bot/ips.json")).toBe(
      "public, max-age=60",
    );
    expect(cacheControlForContentType("text/plain; charset=utf-8", "_assets/x.license.txt")).toBe(
      "public, max-age=3600",
    );
  });

  it("round-trips the build's sidecar and refuses a body it did not write", () => {
    const files = [{ path: "bot/ips.json", contentType: "application/json; charset=utf-8" }];
    expect(parseStaticFilesManifest(formatStaticFilesManifest(files))).toEqual(files);
    expect(() => parseStaticFilesManifest("{}")).toThrow();
  });

  it("emits one Caddy header rule per file", () => {
    expect(
      emitCaddyStaticFileHeaders([
        {
          path: ".well-known/apple-app-site-association",
          contentType: "application/json; charset=utf-8",
        },
        { path: "a.xml", contentType: "text/xml; charset=utf-8" },
      ]),
    ).toBe(
      '@caelo_static_0 path /.well-known/apple-app-site-association\nheader @caelo_static_0 Content-Type "application/json; charset=utf-8"\n' +
        '@caelo_static_1 path /a.xml\nheader @caelo_static_1 Content-Type "text/xml; charset=utf-8"\n',
    );
  });
});
