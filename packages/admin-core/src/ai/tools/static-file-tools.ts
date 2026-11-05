// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1461 — the AI's surface for static files (rules in
 * @caelo-cms/shared `static-files.ts`, docs/dev/static-files.md): two reads,
 * one gated write that takes one file or many, one gated delete.
 */

import {
  STATIC_FILE_CONTENT_TYPES,
  STATIC_FILE_MAX_BATCH,
  STATIC_FILE_MAX_BYTES,
  STATIC_FILE_MAX_COUNT,
  STATIC_FILE_MAX_PATH_LENGTH,
  type StaticFileContentType,
} from "@caelo-cms/shared";
import { z } from "zod";
import { staticFilesSetInput } from "../../ops/static_files.js";
import { makeProposeTool } from "./_make-propose-tool.js";
import { makeListReadTool, makeReadTool } from "./_make-read-tool.js";

interface FileMeta {
  readonly path: string;
  readonly contentType: StaticFileContentType;
  readonly sizeBytes: number;
  readonly releaseState: "not_staged" | "staged" | "live";
  readonly updatedAt: string;
  readonly purpose: string;
}

export const listStaticFilesTool = makeListReadTool({
  name: "list_static_files",
  description:
    "List the site's static data files (JSON, TXT, CSV, XML at a chosen address, like /bot/ips.json or /.well-known/security.txt): path, type, size, why it exists, and `releaseState` (not_staged | staged | live).\n" +
    "USE FOR: before `propose_set_static_files`; when a third party needs a file on the domain. A `not_staged` file goes live with a Stage and the operator's Publish live.",
  opName: "static_files.list",
  input: z.object({ contentType: z.enum(STATIC_FILE_CONTENT_TYPES).optional() }).strict(),
  label: "staticFiles",
  rows: (v) => (v as { files: FileMeta[] }).files,
  columns: [
    { key: "path", value: (r) => r.path },
    { key: "type", value: (r) => r.contentType },
    { key: "bytes", value: (r) => r.sizeBytes },
    { key: "state", value: (r) => r.releaseState },
    { key: "updated", value: (r) => r.updatedAt },
    { key: "purpose", value: (r) => r.purpose },
  ],
  emptyMessage: "No static files yet.",
});

export const getStaticFileTool = makeReadTool({
  name: "get_static_file",
  description:
    "Read one static file's text by path. Read it before `propose_set_static_files` replaces it.",
  opName: "static_files.get",
  input: z.object({ path: z.string().min(2).max(STATIC_FILE_MAX_PATH_LENGTH) }).strict(),
  format: (value) => {
    const f = value as FileMeta & { body: string };
    return `${f.path} (${f.contentType}, ${f.sizeBytes} bytes, ${f.releaseState}). Why: ${f.purpose}\n${f.body}`;
  },
});

export const proposeSetStaticFilesTool = makeProposeTool({
  toolName: "propose_set_static_files",
  opName: "static_files.propose_set",
  pendingQueuePath: "/settings/static-files",
  approvalPreviewOp: "static_files.preview_set",
  when:
    "Create or replace static data files at chosen addresses on the site's domain, served with the right Content-Type like robots.txt: a bot IP list, /.well-known/security.txt, ads.txt, a CSV. One call for several files, they apply together.\n" +
    "DO NOT USE FOR: anything visitors read as a page (pages and modules), images (media), redirects, or HTML, JavaScript, CSS or SVG, which are refused. Google or Bing verification by HTML file: use their DNS or meta-tag route instead.\n" +
    `CORE RULES: \`path\` is the full address (no /api or /_ folders, robots.txt and sitemap.xml are built). Allowed endings are .json, .txt, .csv, .xml or none, and the ending must fit \`contentType\`. At most ${STATIC_FILE_MAX_BYTES / 1024} KiB per file and ${STATIC_FILE_MAX_COUNT} files per site. Send the file exactly as it must be served in \`body\`, as text. After approval it is saved, not live: offer the Stage.`,
  schema: staticFilesSetInput,
  summarize: (_input, preview) => `static files: ${String(preview.summary ?? "?")}`,
});

export const proposeDeleteStaticFilesTool = makeProposeTool({
  toolName: "propose_delete_static_files",
  opName: "static_files.propose_delete",
  pendingQueuePath: "/settings/static-files",
  approvalPreviewOp: "static_files.preview_delete",
  when: "Remove static files by path. The file stays on the live site until the next Stage and Publish live; a third party checking it then fails.",
  schema: z
    .object({
      paths: z
        .array(z.string().min(2).max(STATIC_FILE_MAX_PATH_LENGTH))
        .min(1)
        .max(STATIC_FILE_MAX_BATCH),
    })
    .strict(),
  summarize: (_input, preview) => String(preview.summary ?? "delete static files"),
});
