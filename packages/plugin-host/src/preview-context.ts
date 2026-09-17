// SPDX-License-Identifier: MPL-2.0

import type { PluginContext, PluginContextTier1, PluginQuery } from "@caelo-cms/plugin-sdk";

/** Preview GETs cannot mutate storage, call another operation, or spend provider credits. */
export function previewContext(ctx: PluginContext | PluginContextTier1): PluginContextTier1 {
  const forbidden = async (): Promise<never> => {
    throw new Error("PluginPreviewReadOnly");
  };
  const query = (handle: PluginQuery): PluginQuery =>
    Object.freeze({
      list: handle.list.bind(handle),
      insert: forbidden,
      update: forbidden,
      compareAndSwap: forbidden,
      delete: forbidden,
    });
  const author = ctx as PluginContextTier1;
  return Object.freeze({
    query: query(ctx.query),
    api: Object.freeze({ list: forbidden, get: forbidden }),
    captcha: Object.freeze({ requireProof: forbidden }),
    theme: ctx.theme,
    visitor: ctx.visitor,
    ...(author.fonts ? { fonts: author.fonts } : {}),
    ...(author.invocation ? { invocation: author.invocation } : {}),
    ...(author.privateFiles
      ? {
          privateFiles: Object.freeze({
            stat: author.privateFiles.stat.bind(author.privateFiles),
            readChunk: author.privateFiles.readChunk.bind(author.privateFiles),
            begin: forbidden,
            writeChunk: forbidden,
            commit: forbidden,
            remove: forbidden,
          }),
        }
      : {}),
    ...(author.adminQuery ? { adminQuery: query(author.adminQuery) } : {}),
  });
}
