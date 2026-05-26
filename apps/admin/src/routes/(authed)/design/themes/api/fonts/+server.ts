// SPDX-License-Identifier: MPL-2.0

/**
 * v0.11.1 (issue #76, plan Risk §6.4) — Google Fonts catalog proxy.
 *
 * The TypographyEditor's font picker needs a filtered list of font
 * family names. Fetching the public Google Fonts JSON API from the
 * browser would require CORS-friendly headers (not provided) and would
 * leak the optional API key. Proxy through SvelteKit instead —
 * NOT a Query API op because this is HTTP forwarding, not DB access
 * (CLAUDE.md §2 keeps the Query API for DB ops).
 *
 * In-memory cache for the process lifetime — the catalog rarely
 * changes (Google Fonts adds families monthly) and the picker hits
 * this endpoint per-keystroke.
 *
 * Fallback when GOOGLE_FONTS_API_KEY is unset OR the upstream fails:
 * return a small curated list of common families so the picker still
 * works on a fresh dev install without configuration.
 */

import { json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import type { RequestHandler } from "./$types";

interface GoogleFontEntry {
  family: string;
  category?: string;
  variants?: string[];
}

interface CacheEntry {
  fetchedAt: number;
  families: readonly GoogleFontEntry[];
}

// Curated fallback — used when no API key is configured or upstream
// errors. Covers the families operators ask for most often.
const FALLBACK_FAMILIES: readonly GoogleFontEntry[] = [
  { family: "Inter", category: "sans-serif" },
  { family: "Roboto", category: "sans-serif" },
  { family: "Open Sans", category: "sans-serif" },
  { family: "Lato", category: "sans-serif" },
  { family: "Poppins", category: "sans-serif" },
  { family: "Montserrat", category: "sans-serif" },
  { family: "Source Sans 3", category: "sans-serif" },
  { family: "Nunito", category: "sans-serif" },
  { family: "Raleway", category: "sans-serif" },
  { family: "Work Sans", category: "sans-serif" },
  { family: "Merriweather", category: "serif" },
  { family: "Playfair Display", category: "serif" },
  { family: "Lora", category: "serif" },
  { family: "PT Serif", category: "serif" },
  { family: "Crimson Text", category: "serif" },
  { family: "JetBrains Mono", category: "monospace" },
  { family: "Fira Code", category: "monospace" },
  { family: "Source Code Pro", category: "monospace" },
  { family: "IBM Plex Mono", category: "monospace" },
  { family: "Space Mono", category: "monospace" },
];

let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — catalog changes monthly

async function loadCatalog(): Promise<readonly GoogleFontEntry[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.families;
  }
  const apiKey = process.env.GOOGLE_FONTS_API_KEY;
  if (!apiKey) {
    cache = { fetchedAt: Date.now(), families: FALLBACK_FAMILIES };
    return FALLBACK_FAMILIES;
  }
  try {
    const url = `https://www.googleapis.com/webfonts/v1/webfonts?key=${encodeURIComponent(apiKey)}&sort=popularity`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const body = (await res.json()) as { items?: GoogleFontEntry[] };
    const families = (body.items ?? []).map((f) => ({
      family: f.family,
      category: f.category,
      variants: f.variants,
    }));
    cache = { fetchedAt: Date.now(), families };
    return families;
  } catch (_e) {
    // Don't cache the failure — the operator's next typing burst
    // triggers another try. Fall back to the curated list so the
    // picker stays usable.
    return FALLBACK_FAMILIES;
  }
}

export const GET: RequestHandler = async ({ url, locals }) => {
  requirePermission(locals, "roles.manage");
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const families = await loadCatalog();
  const filtered =
    q.length === 0
      ? families.slice(0, 50)
      : families.filter((f) => f.family.toLowerCase().includes(q)).slice(0, 50);
  return json({ families: filtered });
};
