// SPDX-License-Identifier: MPL-2.0
//
// PLACEHOLDER. Replaced at deploy time by `bun run build:edge-aws`
// which bundles edge-handler.ts + the latest routing-manifest.json
// into a single Lambda@Edge deployment artifact.
//
// Until the build step runs, this stub returns the request unchanged
// so a fresh `pulumi up` doesn't emit a broken Lambda. Operator MUST
// run the build step before the first real deploy.
exports.handler = async (event) => {
  const req = event.Records[0].cf.request;
  // biome-ignore lint/suspicious/noConsole: startup warning visible in CloudWatch
  console.log(
    JSON.stringify({
      kind: "edge_handler_stub",
      message: "edge-handler-bundle.js is the placeholder; run `bun run build:edge-aws`",
      uri: req.uri,
    }),
  );
  return req;
};
