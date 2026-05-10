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

    // Look up page slug + locale to compose the object key.
    const pageR = await execute(toolCtx.registry, toolCtx.adapter, ctx, "pages.get", {
      pageId: input.pageId,
    });
    if (!pageR.ok) {
      return { ok: false, content: `pages.get failed: ${describeError(pageR.error)}` };
    }
    const page = (pageR.value as { page: { slug: string; locale: string } }).page;

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

    // Standard generator output layout: <locale>/<slug>/index.html.
    const objectKey = `${page.locale}/${page.slug}/index.html`;
    const stagingKey = `${runId}/${objectKey}`;

    // Lazy-load @google-cloud/storage so self-hosted runtimes don't
    // pull it. Same pattern as static-publisher-gcs.
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage();

    let html: string;
    let contentLength: number;
    let location: string;
    if (input.target === "staging") {
      const bucket = storage.bucket(stagingBucketName);
      const file = bucket.file(stagingKey);
      const [exists] = await file.exists();
      if (!exists) {
        // Hash-skip: the file was identical to what's already live,
        // so it's only in the static bucket. Fall back.
        const liveBucket = storage.bucket(staticBucketName);
        const liveFile = liveBucket.file(objectKey);
        const [liveExists] = await liveFile.exists();
        if (!liveExists) {
          return {
            ok: false,
            content: `Page not found in staging build ${runId} or live bucket. Page may not exist in this build (incremental Stage filtered it out + it's never been published).`,
          };
        }
        const [liveBody] = await liveFile.download();
        html = liveBody.toString("utf8");
        contentLength = liveBody.byteLength;
        location = `gs://${staticBucketName}/${objectKey} (hash-skipped from staging — file is identical to live)`;
      } else {
        const [body] = await file.download();
        html = body.toString("utf8");
        contentLength = body.byteLength;
        location = `gs://${stagingBucketName}/${stagingKey}`;
      }
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
          page: { id: input.pageId, slug: page.slug, locale: page.locale },
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
