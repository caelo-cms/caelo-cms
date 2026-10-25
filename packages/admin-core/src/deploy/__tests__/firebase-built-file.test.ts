// SPDX-License-Identifier: MPL-2.0

/** #1088 — reading a Firebase build file back from the channel serving it. */

import { describe, expect, it } from "bun:test";
import { readFirebaseBuiltFile } from "../firebase-built-file.js";

function fakeFetch(answers: Record<string, Response>, seen: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(url)} redirect=${init?.redirect}`);
    return answers[String(url)] ?? new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

describe("readFirebaseBuiltFile", () => {
  it("reads the file at exactly its build key under the channel origin", async () => {
    const seen: string[] = [];
    const r = await readFirebaseBuiltFile(
      "https://s--runid-1.web.app",
      "docs/a/index.html",
      fakeFetch({ "https://s--runid-1.web.app/docs/a/index.html": new Response("<html>") }, seen),
    );
    expect(r).toEqual({ found: true, body: Buffer.from("<html>") });
    expect(seen).toEqual(["https://s--runid-1.web.app/docs/a/index.html redirect=manual"]);
  });

  it("treats a redirect as no such file (no cleanUrls: a build file is never redirected)", async () => {
    const r = await readFirebaseBuiltFile(
      "https://s.web.app/",
      "index.html",
      fakeFetch(
        {
          "https://s.web.app/index.html": new Response(null, {
            status: 301,
            headers: { location: "/" },
          }),
        },
        [],
      ),
    );
    expect(r).toEqual({ found: false, status: 301 });
  });

  it("reports the status of a missing file", async () => {
    const r = await readFirebaseBuiltFile(
      "https://s.web.app",
      "gone/index.html",
      fakeFetch({}, []),
    );
    expect(r).toEqual({ found: false, status: 404 });
  });
});
