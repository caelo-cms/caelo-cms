// SPDX-License-Identifier: MPL-2.0

/**
 * caelo_upload_data for the stdio Power shim (docs/data-imports.md): reads
 * one data file from the agent's disk and posts its bytes to the admin's
 * `/api/mcp/data-uploads`. The rows go from the file to Caelo; the model sees only
 * the answer (upload id, columns, row count).
 */

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveTimeoutMs } from "./http.js";
import { describeIapRejection, ingressHeaders } from "./ingress-auth.js";
import { MAX_DATA_FILE_BYTES, uploadDataInput } from "./tool-definitions.js";

/** Read a regular file of 1 byte to {@link MAX_DATA_FILE_BYTES}. */
async function readDataFile(filePath: string): Promise<Uint8Array> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0)
      throw new Error(`${filePath} is not a file with content`);
    if (stat.size > MAX_DATA_FILE_BYTES)
      throw new Error(
        `${filePath} is ${stat.size} bytes, at most ${MAX_DATA_FILE_BYTES}: split it into several files and upload each`,
      );
    // Read at most cap+1 even if the file grows after stat().
    const buffer = Buffer.alloc(MAX_DATA_FILE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > MAX_DATA_FILE_BYTES)
      throw new Error(`${filePath} grew past ${MAX_DATA_FILE_BYTES} bytes`);
    return buffer.subarray(0, total);
  } finally {
    await file.close();
  }
}

/** The base name of a path, on either separator. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Upload one data file; an error result says what to do instead. */
export async function uploadDataFile(
  opts: { adminUrl: string; token: string },
  input: unknown,
): Promise<CallToolResult> {
  const parsed = uploadDataInput.safeParse(input ?? {});
  if (!parsed.success)
    return {
      isError: true,
      content: [{ type: "text", text: `invalid arguments: ${parsed.error.message}` }],
    };
  try {
    const bytes = await readDataFile(parsed.data.filePath);
    const query = new URLSearchParams({ filename: baseName(parsed.data.filePath) });
    const response = await fetch(
      `${opts.adminUrl.replace(/\/+$/, "")}/api/mcp/data-uploads?${query}`,
      {
        method: "POST",
        headers: {
          ...(await ingressHeaders()),
          "x-caelo-mcp-token": opts.token,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(resolveTimeoutMs(120_000)),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      const message =
        describeIapRejection(response, text) ?? `HTTP ${response.status}: ${text.slice(0, 1000)}`;
      return { isError: true, content: [{ type: "text", text: message }] };
    }
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    };
  }
}
