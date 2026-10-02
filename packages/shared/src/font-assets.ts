// SPDX-License-Identifier: MPL-2.0
import { z } from "zod";

export const fontRef = z
  .object({ id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const fontLicense = z
  .object({
    name: z.string().min(1).max(200),
    text: z.string().min(1).max(100_000),
    webEmbedding: z.boolean(),
    documentEmbedding: z.boolean(),
  })
  .strict();
export const fontMetadata = fontRef.extend({
  family: z.string(),
  subfamily: z.string(),
  postscriptName: z.string(),
  cssFamily: z.string(),
  format: z.enum(["ttf", "otf", "woff", "woff2"]),
  weight: z.number(),
  style: z.enum(["normal", "italic"]),
  axes: z.record(z.string(), z.object({ min: z.number(), max: z.number(), default: z.number() })),
  sizeBytes: z.number(),
  glyphCount: z.number(),
  embedding: z.object({
    web: z.boolean(),
    document: z.boolean(),
    subset: z.boolean(),
    restriction: z.string().nullable(),
  }),
  license: fontLicense,
  source: z.string(),
  createdAt: z.string(),
});
export type FontRef = z.infer<typeof fontRef>;
export type FontMetadata = z.infer<typeof fontMetadata>;
export const fontImportInput = z
  .object({
    dataBase64: z.string().min(1).max(11_184_812),
    license: fontLicense,
    source: z.string().min(1).max(1000),
  })
  .strict();
export const fontResolveInput = fontRef
  .extend({
    use: z.enum(["web", "document"]),
    text: z.string().max(200_000).default(""),
    formats: z
      .array(z.enum(["ttf", "otf", "woff", "woff2"]))
      .min(1)
      .max(4),
  })
  .strict();
export const fontReadInput = fontRef
  .extend({ offset: z.number().int().min(0), length: z.number().int().min(1).max(262144) })
  .strict();
export const fontFindInput = z
  .object({
    query: z.string().max(200).default(""),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
