// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { INDEXNOW_ENDPOINT, INDEXNOW_MAX_URLS, WEBSUB_HUB_URL } from "@caelo-cms/shared";
import { searchNotifyDisabledReason } from "./notifications.js";
import { classifyStatus, indexNowRequests, retryAfterSeconds, websubRequest } from "./notify.js";

describe("websubRequest", () => {
  it("is the hub's publish ping for the feed, form-encoded", () => {
    const req = websubRequest("https://example.com/feed.xml");
    expect(req.url).toBe(WEBSUB_HUB_URL);
    expect(req.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(req.body).get("hub.mode")).toBe("publish");
    expect(new URLSearchParams(req.body).get("hub.url")).toBe("https://example.com/feed.xml");
  });
});

describe("indexNowRequests", () => {
  it("submits one request per host, naming that host's key file", () => {
    const reqs = indexNowRequests("abcdef12", [
      "https://example.com/a/",
      "https://de.example.com/b/",
      "https://example.com/c/",
    ]);
    expect(reqs.map((r) => r.url)).toEqual([INDEXNOW_ENDPOINT, INDEXNOW_ENDPOINT]);
    expect(reqs.map((r) => JSON.parse(r.body))).toEqual([
      {
        host: "de.example.com",
        key: "abcdef12",
        keyLocation: "https://de.example.com/abcdef12.txt",
        urlList: ["https://de.example.com/b/"],
      },
      {
        host: "example.com",
        key: "abcdef12",
        keyLocation: "https://example.com/abcdef12.txt",
        urlList: ["https://example.com/a/", "https://example.com/c/"],
      },
    ]);
  });

  it("splits a host's URLs into submissions of at most the protocol's limit", () => {
    const urls = Array.from(
      { length: INDEXNOW_MAX_URLS + 1 },
      (_, i) => `https://example.com/p${i}/`,
    );
    const reqs = indexNowRequests("abcdef12", urls);
    expect(reqs.map((r) => JSON.parse(r.body).urlList.length)).toEqual([INDEXNOW_MAX_URLS, 1]);
  });
});

describe("classifyStatus", () => {
  it("2xx is sent, 429 and 5xx are retried, any other 4xx fails", () => {
    expect(classifyStatus(200)).toBe("sent");
    expect(classifyStatus(202)).toBe("sent");
    expect(classifyStatus(204)).toBe("sent");
    expect(classifyStatus(429)).toBe("retry");
    expect(classifyStatus(503)).toBe("retry");
    expect(classifyStatus(400)).toBe("failed");
    expect(classifyStatus(403)).toBe("failed");
    expect(classifyStatus(422)).toBe("failed");
  });
});

describe("retryAfterSeconds", () => {
  it("reads delta seconds and HTTP dates", () => {
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds("600")).toBe(600);
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(retryAfterSeconds("Fri, 20 Nov 2026 12:10:00 GMT", now)).toBe(600);
    expect(retryAfterSeconds("soon")).toBeNull();
  });
});

describe("searchNotifyDisabledReason", () => {
  it("names the switch when an install turned notifications off", () => {
    expect(searchNotifyDisabledReason({ CAELO_SEARCH_NOTIFY: "off" })).toContain(
      "CAELO_SEARCH_NOTIFY=off",
    );
    expect(searchNotifyDisabledReason({})).toBeNull();
  });
});
