// SPDX-License-Identifier: MPL-2.0
import { z } from "zod";
import { inspectFontBytes, MAX_FONT_BYTES } from "./inspect.js";

const entry = z.object({
  family: z.string(),
  category: z.string().optional(),
  variants: z.array(z.string()).optional(),
  subsets: z.array(z.string()).optional(),
});
export type CatalogEntry = z.infer<typeof entry>;
const curated: CatalogEntry[] = [
  { family: "Inter", category: "sans-serif" },
  { family: "Nunito", category: "sans-serif" },
  { family: "Lato", category: "sans-serif" },
  { family: "Poppins", category: "sans-serif" },
  { family: "Montserrat", category: "sans-serif" },
  { family: "Lora", category: "serif" },
  { family: "Playfair Display", category: "serif" },
  { family: "Merriweather", category: "serif" },
  { family: "Crimson Text", category: "serif" },
  { family: "JetBrains Mono", category: "monospace" },
];

/** Fixed HTTPS origins, no redirects, bounded streaming reads and timeouts. */
export async function fetchFontSource(
  url: string,
  maxBytes: number,
  fetcher = fetch,
): Promise<Uint8Array> {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !["raw.githubusercontent.com", "www.googleapis.com"].includes(parsed.hostname)
  )
    throw new Error("FontSourceNotAllowed");
  if (
    parsed.hostname === "raw.githubusercontent.com" &&
    !parsed.pathname.startsWith("/google/fonts/main/ofl/")
  )
    throw new Error("FontSourceNotAllowed");
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
  if (!response.ok || !response.body) throw new Error(`FontSourceHTTP:${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body.cancel();
    throw new Error("FontSourceTooLarge");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maxBytes) throw new Error("FontSourceTooLarge");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

let cache: { time: number; families: CatalogEntry[] } | undefined;
export async function fontCatalog(query: string, fetcher = fetch) {
  const key = process.env.GOOGLE_FONTS_API_KEY;
  let status: "live" | "cached" | "curated" | "unavailable" = key ? "live" : "curated";
  let families = curated;
  if (key) {
    if (cache && Date.now() - cache.time < 86_400_000) {
      families = cache.families;
      status = "cached";
    } else {
      try {
        const bytes = await fetchFontSource(
          `https://www.googleapis.com/webfonts/v1/webfonts?key=${encodeURIComponent(key)}&sort=popularity`,
          8_000_000,
          fetcher,
        );
        families = z
          .object({ items: z.array(entry).min(1) })
          .parse(JSON.parse(new TextDecoder().decode(bytes))).items;
        cache = { time: Date.now(), families };
      } catch {
        status = "unavailable";
      }
    }
  }
  return {
    source: "google-fonts",
    status,
    families: families
      .filter((f) => f.family.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 50),
  };
}

export const acquireFontInput = z
  .object({
    family: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9 -]+$/),
    filename: z.string().max(240).optional(),
  })
  .strict();
/** Downloads complete faces plus their actual license, never a text-specific subset. */
export async function googleFontFiles(family: string, fetcher = fetch) {
  const slug = family.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!slug) throw new Error("FontFamilyInvalid");
  const base = `https://raw.githubusercontent.com/google/fonts/main/ofl/${slug}/`;
  const metadata = new TextDecoder().decode(
    await fetchFontSource(`${base}METADATA.pb`, 100_000, fetcher),
  );
  const filenames = [
    ...new Set([...metadata.matchAll(/filename:\s*"([^"\r\n]+)"/g)].map((m) => m[1] ?? "")),
  ].filter((name) => /^[A-Za-z0-9_,.[\]-]+\.ttf$/.test(name));
  if (!filenames.length)
    throw new Error("GoogleFontFilesUnavailable: import a licensed font file instead");
  return { base, filenames };
}
export async function acquireGoogleFont(input: z.infer<typeof acquireFontInput>, fetcher = fetch) {
  const { base, filenames } = await googleFontFiles(input.family, fetcher);
  const filename = input.filename ?? filenames.find((f) => !/italic/i.test(f)) ?? filenames[0];
  if (!filename || !filenames.includes(filename)) throw new Error("GoogleFontVariantNotFound");
  const licenseText = new TextDecoder().decode(
    await fetchFontSource(`${base}OFL.txt`, 100_000, fetcher),
  );
  if (!licenseText.includes("SIL OPEN FONT LICENSE"))
    throw new Error("GoogleFontLicenseUnrecognized");
  const source = `${base}${encodeURIComponent(filename)}`;
  const bytes = await fetchFontSource(source, MAX_FONT_BYTES, fetcher);
  const license = {
    name: "OFL-1.1",
    text: licenseText,
    webEmbedding: true,
    documentEmbedding: true,
  };
  inspectFontBytes(bytes, license);
  return { dataBase64: Buffer.from(bytes).toString("base64"), license, source };
}
