// SPDX-License-Identifier: MPL-2.0

/**
 * v0.2.79 — `inspect_built_page` AI tool.
 *
 * Reads the built HTML of a page from the staging or static bucket
 * (cloud installs only). Sibling of `inspect_page_render` which
 * returns the LIVE Postgres render — `inspect_built_page` returns
 * the actual artifact that publishStaging or promoteToProduction
 * uploaded.
 *
 * Why the AI needs this: the live preview and the built artifact
 * can diverge in ways that only show up post-build:
 *   - SEO meta tags (built only — adds <meta name="description">,
 *     OpenGraph, JSON-LD structured data)
 *   - Asset URLs (built has Vite-hashed `/_app/immutable/...`,
 *     preview serves from `/edit/preview-by-path/...`)
 *   - Plugin render transforms (some plugins only emit at build time)
 *   - robots.txt + routing-manifest.json (per-target overrides)
 *   - CSP-relevant external script src attributes
 *
 * After Stage, the AI can call this on the just-published runId,
 * compare against the chat-iframe expectations (or against the live
 * `static` target when verifying a Confirm-publish), and proactively
 * flag drift to the operator before they click Confirm.
 *
 * Self-hosted installs return a NotImplemented error — built HTML
 * lives on the operator's local disk, not behind a storage API
 * the admin process can read uniformly.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import { readStagedBuildFiles, readStagedObject } from "../../deploy/staged-build-files.js";
import { describeError } from "./_describe-error.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

const inspectBuiltInput = z
  .object({
    pageId: z.string().uuid(),
    /** Which bucket to read from. `staging` reads
     *  gs://<staging-bucket>/<runId>/<path>; `static` reads
     *  gs://<static-bucket>/<path> (the live site). Default
     *  `staging` because the typical use is verifying a fresh
     *  Stage. */
    target: z.enum(["staging", "static"]).default("staging"),
    /** When `target='staging'`, pin to a specific runId. Defaults to
     *  the most recent succeeded staging run for the given page's
     *  branch (looked up from deploy_runs). */
    runId: z.string().uuid().optional(),
  })
  .strict();

export type InspectBuiltPageInput = z.infer<typeof inspectBuiltInput>;

export const inspectBuiltPageTool: ToolDefinitionWithHandler<InspectBuiltPageInput> = {
  name: "inspect_built_page",
  description:
    "Read the BUILT HTML of a page from the staging or static bucket — what publishStaging or promoteToProduction actually uploaded. " +
    "USE THIS AFTER STAGE to verify the build matches the live preview's expectations. Catches drift the live preview can't show: SEO meta absence, hashed-asset URLs, plugin render transforms, CSP-relevant <script src> tags, robots.txt overrides. " +
    "Default target='staging' reads from the staged build; pass target='static' to read what's currently serving production. " +
    "Cloud-only (CAELO_PROVIDER=gcp). Self-hosted Stage writes to local disk; that path returns a NotImplemented error here.",
  schema: inspectBuiltInput,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: { type: "string", format: "uuid" },
      target: {
        type: "string",
        enum: ["staging", "static"],
        description:
          "Which bucket. 'staging' = the most recent staged build. 'static' = the live site.",
      },
      runId: {
        type: "string",
        format: "uuid",
        description:
          "Optional. When target='staging', pin to a specific runId. Defaults to the most recent succeeded staging run.",
      },
    },
  },
  handler: async (ctx, input, toolCtx) => {
    if (process.env.CAELO_PROVIDER !== "gcp") {
      return {
        ok: false,
        content:
          "inspect_built_page is only available on GCP installs. CAELO_PROVIDER is not 'gcp' (you may be on self-hosted, AWS, or Azure). Use inspect_page_render to read the live Postgres render instead.",
      };
    }

    // Look up the page slug to compose the object key.
    const pageR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get", {
      pageId: input.pageId,
    });
    if (!pageR.ok) {
      return { ok: false, content: `pages.get failed: ${describeError(pageR.error)}` };
    }
    const page = (pageR.value as { page: { slug: string; currentPath: string } }).page;

    // Resolve runId for staging target if not pinned.
    let runId = input.runId;
    if (input.target === "staging" && !runId) {
      const runsR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "deploy.list_runs", {
        limit: 50,
      });
      if (runsR.ok) {
        const runs = (runsR.value as { runs: { id: string; targetName: string; status: string }[] })
          .runs;
        const latestStaging = runs.find(
          (r) => r.targetName === "staging" && r.status === "succeeded",
        );
        if (latestStaging) runId = latestStaging.id;
      }
      if (!runId) {
        return {
          ok: false,
          content:
            "No succeeded staging run found in the last 50 deploys. Run Stage first, then call inspect_built_page.",
        };
      }
    }

    const staticBucketName = process.env.CAELO_STATIC_BUCKET;
    const stagingBucketName = process.env.CAELO_STAGING_BUCKET;
    if (!staticBucketName || !stagingBucketName) {
      return {
        ok: false,
        content:
          "CAELO_STATIC_BUCKET / CAELO_STAGING_BUCKET not set. The GCP Pulumi stack should set these env vars on the admin Cloud Run service.",
      };
    }

    // Standard (directory-style) generator output: the composed path
    // (pages.current_path — parent chain + plugin prefixes included) +
    // /index.html; the root is index.html.
    const trimmedPath = page.currentPath.replace(/^\/+|\/+$/g, "");
    const objectKey = trimmedPath.length === 0 ? "index.html" : `${trimmedPath}/index.html`;
    const stagingKey = `${runId}/${objectKey}`;

    // Lazy-load @google-cloud/storage so self-hosted runtimes don't
    // pull it. Same pattern as static-publisher-gcs.
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage();

    let html: string;
    let contentLength: number;
    let location: string;
    if (input.target === "staging") {
      // Resolved above (or returned); TS does not carry that narrowing here.
      if (!runId) throw new Error("inspect_built_page: staging runId unresolved");
      // Hash-skipped files are only live; readStagedObject falls back to
      // live for files the build contains, never for a page it dropped
      // (#842 — that one is still live until Confirm-publish prunes it).
      const staging = storage.bucket(stagingBucketName);
      let object: Awaited<ReturnType<typeof readStagedObject>>;
      try {
        object = await readStagedObject({
          staging,
          live: storage.bucket(staticBucketName),
          runId,
          buildFiles: await readStagedBuildFiles(staging, runId),
          key: objectKey,
        });
      } catch (e) {
        // A run staged by an older release (no file list) or a live copy
        // removed after Stage — the message names the fix (Run Stage again).
        return { ok: false, content: (e as Error).message };
      }
      if (!object) {
        return {
          ok: false,
          content: `Page not in staging build ${runId} (gs://${stagingBucketName}/${stagingKey}). The page was not published (still a draft) or not part of this build when it was staged — publish it and run Stage again.`,
        };
      }
      html = object.body.toString("utf8");
      contentLength = object.body.byteLength;
      location = object.fromLive
        ? `${object.location} (hash-skipped from staging — file is identical to live)`
        : object.location;
    } else {
      const bucket = storage.bucket(staticBucketName);
      const file = bucket.file(objectKey);
      const [exists] = await file.exists();
      if (!exists) {
        return {
          ok: false,
          content: `Page not in live bucket gs://${staticBucketName}/${objectKey}. Confirm-publish may not have included this page yet.`,
        };
      }
      const [body] = await file.download();
      html = body.toString("utf8");
      contentLength = body.byteLength;
      location = `gs://${staticBucketName}/${objectKey}`;
    }

    return {
      ok: true,
      content: JSON.stringify(
        {
          page: { id: input.pageId, slug: page.slug },
          target: input.target,
          runId: input.target === "staging" ? runId : undefined,
          location,
          contentLength,
          html,
        },
        null,
        2,
      ),
    };
  },
};
