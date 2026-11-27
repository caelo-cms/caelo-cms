// SPDX-License-Identifier: MPL-2.0

/**
 * Declarative collection operations, executed (epic #1644, R3 #1649, R7
 * #1650): `search`, `suggest` and `read` over an open collection release,
 * with the release's search profile. Shared by the gateway (visitors) and
 * the admin (the AI's preview and the Stage audit's test queries), so both
 * answer a query the same way. No plugin code runs here: the operation's
 * declaration and the release are data.
 *
 * Search ranks words (BM25F with synonyms, typo tolerance, compounds) and,
 * when the profile asks for it and the release carries vectors, meaning
 * (the query's vector against the passages'), fused by reciprocal rank.
 * Documents of a declared anchor collection whose text matches describe
 * the document they point at. Best bets come first. With `explain`, each
 * hit says where it comes from (admin only).
 */

import {
  analyze,
  columnValues,
  docPosition,
  foldDiacritics,
  fuse,
  highlight,
  idTerm,
  type KeyedDoc,
  keysOfTerms,
  keysPassing,
  keywordTerm,
  keywordValues,
  lookupDocs,
  numberValue,
  type OpenRelease,
  type Passage,
  primaryLanguage,
  searchText,
  searchVectors,
  snippet,
  type TextQuery,
} from "@caelo-cms/collection-index";
import type { Embedder } from "@caelo-cms/models";
import type { CollectionOperationManifest, SearchProfile } from "@caelo-cms/plugin-sdk";
import {
  EMBEDDING_MODELS,
  type EmbeddingModel,
  embeddingModelFingerprint,
} from "@caelo-cms/shared";

/** Words a query may have; more is refused, not cut. */
export const MAX_QUERY_WORDS = 10;

/** One answer of the module: a status, a JSON body and how it may be cached. */
export interface CollectionAnswer {
  readonly status: number;
  readonly body: unknown;
  /** Seconds the CDN may keep it; null: no-store. */
  readonly cacheSeconds: number | null;
}

/** An open release with its search profile. */
export interface OpenEntry {
  readonly release: OpenRelease;
  readonly profile: SearchProfile | null;
}

/** Embeds a visitor's query; the gateway's is WebAssembly (see {@link wasmQueryEmbedder}). */
export type QueryEmbedder = (fingerprint: string, query: string) => Promise<Float32Array>;

/** Query vectors kept per gateway: a query is embedded once, whatever page or filter follows. */
const QUERY_VECTORS = 2000;

/** Candidates the vector side ranks before the fusion. */
const VECTOR_CANDIDATES = 50;

/**
 * When results are merged (the meaning side, link texts, boosts), every page
 * slices one fused order of this many candidates: a window that grew with
 * the page would change the fusion's inputs and reorder hits a visitor has
 * already seen. A pure word search stays exact on every page (its top-k is
 * prefix-stable).
 */
const MERGED_CANDIDATES = 50;

/** The query's filter, applied to a document whatever source found it. */
interface DocFilter {
  readonly langs: readonly string[] | null;
  readonly keywords: Readonly<Record<string, readonly string[]>>;
  readonly ranges: Readonly<Record<string, { readonly gte?: number; readonly lte?: number }>>;
}

function passesFilter(doc: KeyedDoc, f: DocFilter): boolean {
  if (f.langs && !f.langs.includes(doc.lang)) return false;
  for (const [field, allowed] of Object.entries(f.keywords))
    if (!keywordValues(doc, field).some((v) => allowed.includes(v))) return false;
  for (const [field, r] of Object.entries(f.ranges)) {
    const v = numberValue(doc, field);
    if (Number.isNaN(v)) return false;
    if (r.gte !== undefined && v < r.gte) return false;
    if (r.lte !== undefined && v > r.lte) return false;
  }
  return true;
}

/** The model a release's fingerprint names is not in this gateway's catalog. */
export class ModelUnavailableError extends Error {
  override readonly name = "ModelUnavailableError";
}

/** The catalog model behind a release's vector fingerprint, or undefined. */
export function modelOfFingerprint(fingerprint: string): EmbeddingModel | undefined {
  return EMBEDDING_MODELS.find((m) => embeddingModelFingerprint(m) === fingerprint);
}

/** A query embedder that can also load its model ahead of the first query. */
export type WarmableQueryEmbedder = QueryEmbedder & {
  /**
   * Loads the model behind `fingerprint`, shared with every query that
   * needs it. Rejects like a query would: an unknown model, files that fail
   * verification.
   */
  ready(fingerprint: string): Promise<void>;
};

/**
 * The query embedder on WebAssembly: one embedder per model, loaded on
 * first use and kept; query vectors in a small LRU. The runtime is
 * imported lazily, so a process without semantic search never loads it.
 *
 * It runs in the process's own thread. Without its token table in the
 * graph (#1782) a load holds the event loop for about 75 ms on an M3
 * (before: more than half a second); a worker thread would cut that to
 * about 15 ms but add 0.5 to 1 s to every load (its own runtime, its own
 * WebAssembly compile), and the load is what a cold instance's first
 * search waits for (#1778, measured in docs/dev/embedding-models.md).
 *
 * Each load writes one log line with its duration and the process's
 * memory, so a slow first search can be told apart from a slow index.
 */
export function wasmQueryEmbedder(): WarmableQueryEmbedder {
  const embedders = new Map<string, Promise<Embedder>>();
  const vectors = new Map<string, Float32Array>();
  const embedderOf = (fingerprint: string): Promise<Embedder> => {
    let e = embedders.get(fingerprint);
    if (!e) {
      const model = modelOfFingerprint(fingerprint);
      if (!model) {
        return Promise.reject(
          new ModelUnavailableError(
            `the release was embedded with ${fingerprint}, which this gateway's model catalog does not have (an admin and gateway of different releases?)`,
          ),
        );
      }
      const started = performance.now();
      const took = () => Math.round(performance.now() - started);
      e = import("@caelo-cms/models/wasm")
        .then((m) => m.createWasmEmbedder(model))
        .then(
          (embedder) => {
            console.log(
              `[collections] model ${model.id} loaded in ${took()} ms (process memory ${Math.round(process.memoryUsage().rss / 1048576)} MiB)`,
            );
            return embedder;
          },
          (err: unknown) => {
            console.error(
              `[collections] model ${model.id} failed to load after ${took()} ms: ${err instanceof Error ? err.message : String(err)}`,
            );
            throw err;
          },
        );
      e.catch(() => embedders.delete(fingerprint));
      embedders.set(fingerprint, e);
    }
    return e;
  };
  const embed = async (fingerprint: string, query: string): Promise<Float32Array> => {
    const key = `${fingerprint}\n${query}`;
    const hit = vectors.get(key);
    if (hit) {
      vectors.delete(key);
      vectors.set(key, hit);
      return hit;
    }
    const [vector] = await (await embedderOf(fingerprint)).embed([query], "query");
    vectors.set(key, vector as Float32Array);
    while (vectors.size > QUERY_VECTORS) vectors.delete(vectors.keys().next().value as string);
    return vector as Float32Array;
  };
  return Object.assign(embed, {
    ready: async (fingerprint: string): Promise<void> => {
      await embedderOf(fingerprint);
    },
  });
}

function fail(status: number, kind: string, message: string): CollectionAnswer {
  return { status, body: { ok: false, error: { kind, message } }, cacheSeconds: null };
}

/** A language tag the engine accepts. */
function languageOf(raw: string | null): string | null {
  if (raw === null) return null;
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/.test(raw) ? raw.toLowerCase() : null;
}

/** The text a best bet is matched on: folded words, single-spaced. */
export function normalizeQuery(text: string, lang: string): string {
  return analyze(text, lang, { keepStopwords: true })
    .map((t) => t.exact)
    .join(" ");
}

function returned(doc: KeyedDoc, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { id: doc.id, lang: doc.lang };
  for (const f of fields) if (f in doc.values) out[f] = doc.values[f];
  return out;
}

function synonymsOf(profile: SearchProfile, lang: string): ReadonlyMap<string, readonly string[]> {
  const table = profile.synonyms[primaryLanguage(lang)] ?? {};
  return new Map(
    Object.entries(table).map(([w, alts]) => [foldDiacritics(w.toLowerCase()), alts] as const),
  );
}

/** Hits a visitor conversation's search tool asks for (#1654): the model reads at most these. */
export const AI_CHAT_SEARCH_HITS = 5;

/**
 * #1654 / #1655 — the parameters of one `ai-chat` tool call: what the
 * gateway sends for the model's input, and what an admin-side run (the
 * Stage audit, a preview) sends for the same input, so both see the same
 * pages. `input` is the model's: `{ query }` for a search tool, the read
 * operation's key (`url`, or `id`) for a read tool.
 */
export function aiChatToolParams(
  op: CollectionOperationManifest,
  input: Readonly<Record<string, string>>,
  lang: string,
): URLSearchParams {
  if (op.kind === "search")
    return new URLSearchParams({
      q: input.query ?? "",
      lang,
      limit: String(Math.min(AI_CHAT_SEARCH_HITS, op.maxResults)),
    });
  if (op.kind === "read") {
    const value = input[op.by === "id" ? "id" : op.by] ?? "";
    return new URLSearchParams(op.by === "id" ? { id: value } : { value });
  }
  throw new Error(`a ${op.kind} operation is no ai-chat tool`);
}

/** What a run needs besides the operation and its release. */
export interface RunCollectionOptions {
  readonly embedQuery: QueryEmbedder;
  /** The anchor collection's open release, when the operation declares `anchors`. */
  readonly anchors?: OpenEntry | null;
  /** Each hit says where it comes from (the admin's preview; never visitors). */
  readonly explain?: boolean;
}

export async function runCollectionOperation(
  op: CollectionOperationManifest,
  entry: OpenEntry,
  releaseKey: string,
  params: URLSearchParams,
  opts: RunCollectionOptions,
): Promise<CollectionAnswer> {
  const embedQuery = opts.embedQuery;
  const { release, profile } = entry;
  if (op.kind === "read") {
    const value = op.by === "id" ? params.get("id") : params.get("value");
    if (!value || value.length > 500)
      return fail(400, "InvalidInput", `pass ${op.by === "id" ? "id" : "value"}`);
    const docs = (
      await lookupDocs(release, [op.by === "id" ? idTerm(value) : keywordTerm(op.by, value)])
    ).slice(0, op.maxDocuments);
    const anchor = params.get("passage");
    return {
      status: 200,
      cacheSeconds: op.cacheSeconds,
      body: {
        release: releaseKey,
        documents: docs.map((d) => {
          const out = returned(d, op.returns);
          if (op.passages) {
            const all = (d.values[op.passages] ?? []) as Passage[];
            out[op.passages] = anchor ? all.filter((p) => p.anchor === anchor) : all;
          }
          return out;
        }),
      },
    };
  }
  if (!profile)
    return fail(
      503,
      "ProfileMissing",
      "the collection has no search profile yet: the plugin sets it at the next Stage",
    );
  const lang = languageOf(params.get("lang"));
  if (!lang) return fail(400, "InvalidInput", "pass lang, the visitor's language tag (e.g. de)");
  const q = (params.get("q") ?? "").trim();
  if (q.length > (op.kind === "search" ? op.maxQueryChars : 120))
    return fail(400, "InvalidInput", "the query is too long");
  if (analyze(q, lang).length > MAX_QUERY_WORDS)
    return fail(400, "InvalidInput", `at most ${MAX_QUERY_WORDS} words`);
  const langFilter =
    op.kind === "search" && op.language === "visitor" && !profile.crossLanguage
      ? [lang]
      : undefined;

  if (op.kind === "suggest") {
    const curated = profile.suggestions[primaryLanguage(lang)] ?? [];
    const folded = foldDiacritics(q.toLowerCase());
    const queries = (
      q === ""
        ? curated
        : curated.filter(
            (s) =>
              foldDiacritics(s.text.toLowerCase())
                .split(/\s+/)
                .some((w) => w.startsWith(folded)) ||
              foldDiacritics(s.text.toLowerCase()).startsWith(folded),
          )
    ).slice(0, op.maxResults);
    let docs: Record<string, unknown>[] = [];
    if (q !== "" && profile.prefix) {
      const r = await searchText(release, {
        text: q,
        lang,
        weights: profile.weights,
        limit: op.maxResults,
        prefix: true,
        typos: false,
        compounds: profile.compounds,
        synonyms: synonymsOf(profile, lang),
        protectedTerms: new Set(profile.protectedTerms),
        filter: { langs: [lang] },
      });
      docs = await storedOf(
        release,
        r.hits.map((h) => h.key),
        op.returns,
      );
    }
    return {
      status: 200,
      cacheSeconds: op.cacheSeconds,
      body: { release: releaseKey, queries, docs },
    };
  }

  // search
  if (q === "") return fail(400, "InvalidInput", "pass q, the query");
  const limit = Math.min(Number.parseInt(params.get("limit") ?? "10", 10) || 10, op.maxResults);
  const page = Math.max(1, Math.min(Number.parseInt(params.get("page") ?? "1", 10) || 1, 50));
  const keywords: Record<string, string[]> = {};
  for (const f of op.filters) {
    const values = params
      .getAll(`f.${f}`)
      .filter((v) => v.length <= 200)
      .slice(0, 20);
    if (values.length > 0) keywords[f] = values;
  }
  const ranges: Record<string, { gte?: number; lte?: number }> = {};
  for (const f of op.ranges) {
    const gte = Number(params.get(`min.${f}`) ?? Number.NaN);
    const lte = Number(params.get(`max.${f}`) ?? Number.NaN);
    if (Number.isFinite(gte) || Number.isFinite(lte))
      ranges[f] = {
        ...(Number.isFinite(gte) ? { gte } : {}),
        ...(Number.isFinite(lte) ? { lte } : {}),
      };
  }
  const docFilter: DocFilter = { langs: langFilter ?? null, keywords, ranges };
  const merging =
    Boolean(profile.semantic && release.manifest.vectorModel) ||
    profile.boosts.length > 0 ||
    Boolean(op.anchors && opts.anchors?.release);
  const query: TextQuery = {
    text: q,
    lang,
    weights: profile.weights,
    limit: merging ? MERGED_CANDIDATES : limit * page,
    facets: op.facets,
    typos: profile.typos,
    compounds: profile.compounds,
    synonyms: synonymsOf(profile, lang),
    protectedTerms: new Set(profile.protectedTerms.map((t) => foldDiacritics(t.toLowerCase()))),
    filter: { ...(langFilter ? { langs: langFilter } : {}), keywords, ranges },
  };
  // #1779 — what does not wait on each other starts together: the words in
  // the pages, the words in the link texts, and the query's vector with its
  // search. A cold instance then waits for each round of reads once.
  const anchorsOf = op.anchors && opts.anchors?.release ? opts.anchors : null;
  const fingerprint = release.manifest.vectorModel?.id;
  const semantic = profile.semantic && fingerprint ? profile.semantic : null;
  let r: Awaited<ReturnType<typeof searchText>>;
  let ar: Awaited<ReturnType<typeof searchText>> | null;
  let near: Awaited<ReturnType<typeof searchVectors>> | null;
  try {
    [r, ar, near] = await Promise.all([
      searchText(release, query),
      anchorsOf
        ? searchText(anchorsOf.release, {
            text: q,
            lang,
            weights: anchorsOf.profile?.weights ?? { text: 1 },
            limit: 200,
            typos: profile.typos,
            compounds: profile.compounds,
            synonyms: synonymsOf(profile, lang),
            protectedTerms: query.protectedTerms,
            ...(langFilter ? { filter: { langs: langFilter } } : {}),
          })
        : Promise.resolve(null),
      semantic && fingerprint
        ? embedQuery(fingerprint, q).then((vector) =>
            searchVectors(release, {
              vector,
              limit: VECTOR_CANDIDATES,
              minSimilarity: semantic.minSimilarity,
              filter: query.filter ?? {},
            }),
          )
        : Promise.resolve(null),
    ]);
  } catch (e) {
    if (e instanceof ModelUnavailableError) return fail(503, "ModelUnavailable", e.message);
    throw e;
  }
  let keys = r.hits.map((h) => h.key);
  // A candidate's place score before boosts: its word score, plus what other
  // pages' link texts add (below). Boosts multiply this, never the bare word
  // score, so a boost leaves the link texts' contribution in place.
  let placeScore = new Map(r.hits.map((h) => [h.key, h.score] as const));
  // #1651 — anchor texts: the words other pages link a document with.
  /** The anchor hits by the key of the document they name. */
  const anchorByKey = new Map<number, { score: number; texts: string[]; sources: number }>();
  if (op.anchors && anchorsOf && ar && ar.hits.length > 0) {
    const a = op.anchors;
    const facts = await anchorFacts(
      anchorsOf.release,
      ar.hits.map((h) => h.key),
      a.target,
      a.sources ?? null,
      opts.explain === true,
    );
    const anchorHits = new Map<string, { score: number; texts: string[]; sources: number }>();
    for (const h of ar.hits) {
      const f = facts.get(h.key);
      if (!f || f.target === null) continue;
      // A text many pages use counts more, with diminishing weight.
      const score = h.score * (1 + Math.log10(Math.max(1, f.sources)));
      const at = anchorHits.get(f.target) ?? { score: 0, texts: [], sources: 0 };
      at.score = Math.max(at.score, score);
      if (at.texts.length < 3 && f.text !== null) at.texts.push(f.text);
      at.sources += f.sources;
      anchorHits.set(f.target, at);
    }
    if (anchorHits.size > 0) {
      // The target is a document id, or (targetField) a keyword value such as
      // a page's path: whatever document holds it when the visitor searches
      // is what the link names. Resolved through the terms' postings.
      const field = a.targetField;
      const termOf = (t: string) => (field === undefined ? idTerm(t) : keywordTerm(field, t));
      const targets = [...anchorHits.keys()];
      const held = await keysOfTerms(release, targets.map(termOf));
      for (const t of targets)
        for (const k of held.get(termOf(t)) ?? []) {
          const hit = anchorHits.get(t);
          if (hit && !anchorByKey.has(k)) anchorByKey.set(k, hit);
        }
      // A link text names its target whatever the visitor filtered for.
      const passing = await keysPassing(release, [...anchorByKey.keys()], query.filter);
      const scored = new Map<number, number>(r.hits.map((h) => [h.key, h.score] as const));
      for (const [k, hit] of anchorByKey) {
        if (!passing.has(k)) continue;
        scored.set(k, (scored.get(k) ?? 0) + hit.score);
      }
      placeScore = scored;
      keys = [...scored.entries()]
        .sort((x, y) => y[1] - x[1] || x[0] - y[0])
        .map(([k]) => k)
        .slice(0, MERGED_CANDIDATES);
    }
  }
  // #1650 — the meaning side: the query's vector against the passages'.
  const bestPassage = new Map<number, number>();
  if (near && semantic) {
    for (const h of near) bestPassage.set(h.key, h.passage);
    keys = fuse(
      [
        { keys, weight: 1 },
        { keys: near.map((h) => h.key), weight: semantic.weight },
      ],
      MERGED_CANDIDATES,
    ).map((h) => h.key);
  }
  if (profile.boosts.length > 0) {
    // Boosts multiply a document's place score: its word score with what
    // link texts add, or, after the fusion, its fused rank turned into a
    // descending score. The factors come from the keyword values' postings.
    const score =
      bestPassage.size > 0
        ? new Map(keys.map((k, i) => [k, keys.length - i] as const))
        : placeScore;
    const factor = await boostFactors(release, keys, profile.boosts);
    const boosted = (k: number): number => (score.get(k) ?? 0) * (factor.get(k) ?? 1);
    keys = [...keys].sort((a, b) => boosted(b) - boosted(a) || a - b);
  }
  // Best bets: the documents the operator pinned for this query come first, in order.
  const pinnedIds =
    (profile.bestBets[primaryLanguage(lang)] ?? []).find(
      (b) => normalizeQuery(b.query, lang) === normalizeQuery(q, lang),
    )?.ids ?? [];
  const pinnedDocs = pinnedIds.length > 0 ? await lookupDocs(release, pinnedIds.map(idTerm)) : [];
  // A pinned page is still one of the visitor's filters and language.
  const pinnedOrder = pinnedIds
    .map((id) => pinnedDocs.find((d) => d.id === id))
    .filter((d): d is KeyedDoc => d !== undefined && passesFilter(d, docFilter));
  const ordered = [
    ...pinnedOrder.map((d) => d.key),
    ...keys.filter((k) => !pinnedOrder.some((d) => d.key === k)),
  ];
  const pageKeys = ordered.slice((page - 1) * limit, page * limit);
  // Full documents only for the page shown.
  const stored = await storedMap(
    release,
    pageKeys.filter((k) => !pinnedOrder.some((d) => d.key === k)),
  );
  for (const d of pinnedOrder) stored.set(d.key, d);
  const hits = pageKeys
    .map((k) => stored.get(k))
    .filter((d): d is KeyedDoc => d !== undefined)
    .map((d) => {
      const out = returned(d, op.returns);
      if (typeof d.values.title === "string" && op.returns.includes("title"))
        out.titleHighlights = highlight(d.values.title, r.terms, d.lang).highlights;
      if (op.snippet) {
        // A document only the meaning side found shows its closest passage.
        const lexical = r.hits.some((h) => h.key === d.key);
        out.snippet = snippet(
          (d.values[op.snippet] ?? []) as Passage[],
          r.terms,
          d.lang,
          220,
          lexical ? undefined : bestPassage.get(d.key),
        );
      }
      if (pinnedOrder.some((p) => p.key === d.key)) out.pinned = true;
      if (opts.explain)
        out.why = explainHit(d, {
          terms: r.terms,
          query: q,
          lang,
          corrections: r.corrections,
          splits: r.splits,
          synonyms: synonymsOf(profile, lang),
          lexical: r.hits.some((h) => h.key === d.key),
          semantic: bestPassage.has(d.key),
          anchors: anchorByKey.get(d.key) ?? null,
          pinned: pinnedOrder.some((p) => p.key === d.key),
        });
      return out;
    });
  return {
    status: 200,
    cacheSeconds: op.cacheSeconds,
    body: {
      release: releaseKey,
      query: q,
      total:
        Math.max(r.total, keys.length) + pinnedOrder.filter((d) => !keys.includes(d.key)).length,
      page,
      // Whether a next page has hits: a merged order ends with its window.
      more: page * limit < (merging ? ordered.length : r.total + pinnedOrder.length),
      hits,
      facets: r.facets,
      corrections: r.corrections,
      splits: r.splits,
    },
  };
}

/** Where one hit comes from, for the admin's preview. */
export interface HitExplanation {
  /** Fields whose words matched, with the words as the document spells them. */
  readonly fields: readonly { readonly field: string; readonly words: readonly string[] }[];
  /** How a matched word relates to the query: as typed, its stem, a synonym, a typo fix, a compound part. */
  readonly via: readonly string[];
  readonly anchors: { readonly texts: readonly string[]; readonly sources: number } | null;
  readonly semantic: boolean;
  readonly pinned: boolean;
}

function explainHit(
  doc: KeyedDoc,
  x: {
    readonly terms: Parameters<typeof highlight>[1];
    readonly query: string;
    readonly lang: string;
    readonly corrections: readonly { readonly from: string; readonly to: string }[];
    readonly splits: readonly {
      readonly from: string;
      readonly parts: readonly [string, string];
    }[];
    readonly synonyms: ReadonlyMap<string, readonly string[]>;
    readonly lexical: boolean;
    readonly semantic: boolean;
    readonly anchors: { readonly texts: string[]; readonly sources: number } | null;
    readonly pinned: boolean;
  },
): HitExplanation {
  const fields: { field: string; words: string[] }[] = [];
  const texts: [string, string][] = [];
  for (const [name, value] of Object.entries(doc.values)) {
    if (typeof value === "string") texts.push([name, value]);
    else if (Array.isArray(value))
      for (const p of value as Passage[])
        if (p && typeof p === "object" && "text" in p) {
          texts.push([`${name}.heading`, String(p.heading ?? "")]);
          texts.push([`${name}.text`, String(p.text ?? "")]);
        }
  }
  if (x.lexical) {
    for (const [field, text] of texts) {
      const h = highlight(text, x.terms, doc.lang).highlights;
      if (h.length === 0) continue;
      const words = [...new Set(h.map(([a, b]) => text.slice(a, b)))].slice(0, 5);
      const at = fields.find((f) => f.field === field);
      if (at) at.words.push(...words.filter((w) => !at.words.includes(w)));
      else fields.push({ field, words });
    }
  }
  const typed = new Set(analyze(x.query, x.lang, { keepStopwords: true }).map((t) => t.exact));
  const via = new Set<string>();
  for (const f of fields) {
    for (const w of f.words) {
      const folded = foldDiacritics(w.toLowerCase());
      if (typed.has(folded)) via.add(`"${w}" as typed`);
      else if (x.corrections.some((c) => c.to === folded))
        via.add(`"${w}" for the typo "${x.corrections.find((c) => c.to === folded)?.from}"`);
      else if (
        [...x.synonyms.entries()].some(
          ([k, alts]) =>
            typed.has(k) && alts.some((a) => foldDiacritics(a.toLowerCase()) === folded),
        )
      )
        via.add(`"${w}" as a synonym`);
      else if (x.splits.some((s) => s.parts.includes(folded)))
        via.add(`"${w}" as part of a compound`);
      else via.add(`"${w}" as a form of a query word`);
    }
  }
  return {
    fields,
    via: [...via],
    anchors: x.anchors ? { texts: x.anchors.texts, sources: x.anchors.sources } : null,
    semantic: x.semantic,
    pinned: x.pinned,
  };
}

/** What a search needs of one link-text hit: its target, its weight and (explain) its text. */
interface AnchorFact {
  readonly target: string | null;
  readonly sources: number;
  readonly text: string | null;
}

/**
 * The target and weight of each link-text hit (#1779), from the docs file:
 * the target is a keyword column the index keeps for this (collectionColumns
 * in the admin), the weight a number column. Stored documents are read only
 * for the texts an explanation shows, and for a segment built before the
 * column existed (format 2) until its release is rebuilt.
 */
async function anchorFacts(
  release: OpenRelease,
  keys: readonly number[],
  target: string,
  sources: string | null,
  withText: boolean,
): Promise<Map<number, AnchorFact>> {
  const out = new Map<number, AnchorFact>();
  await Promise.all(
    release.segments.map(async (seg) => {
      const m = seg.reader.manifest;
      const mine = keys.filter((k) => k >= m.firstKey && k <= m.lastKey && !seg.removed.has(k));
      if (mine.length === 0) return;
      const docs = await seg.reader.docs();
      const column = docs.columns.get(target);
      const weights = sources ? docs.numbers.get(sources) : undefined;
      const stored = withText || !column ? await seg.reader.stored(mine) : null;
      for (const k of mine) {
        const at = docPosition(docs, k);
        if (at < 0) continue;
        const d = stored?.get(k);
        const value = column ? (columnValues(column, at)[0] ?? null) : d?.values[target];
        const weight = sources
          ? weights
            ? (weights[at] as number)
            : Number(d?.values[sources] ?? 1)
          : 1;
        out.set(k, {
          target: typeof value === "string" ? value : null,
          sources: Number.isNaN(weight) ? 1 : weight,
          text: typeof d?.values.text === "string" ? d.values.text : null,
        });
      }
    }),
  );
  return out;
}

/** Each key's boost factor: the product of its keyword values' multipliers, from their postings (#1779). */
async function boostFactors(
  release: OpenRelease,
  keys: readonly number[],
  boosts: SearchProfile["boosts"],
): Promise<Map<number, number>> {
  const wanted = new Set(keys);
  const out = new Map<number, number>();
  const terms: { term: string; factor: number }[] = [];
  for (const b of boosts)
    for (const [value, factor] of Object.entries(b.values))
      terms.push({ term: keywordTerm(b.field, value), factor });
  const held = await keysOfTerms(
    release,
    terms.map((t) => t.term),
  );
  for (const t of terms)
    for (const k of held.get(t.term) ?? [])
      if (wanted.has(k)) out.set(k, (out.get(k) ?? 1) * t.factor);
  return out;
}

async function storedMap(
  release: OpenRelease,
  keys: readonly number[],
): Promise<Map<number, KeyedDoc>> {
  const out = new Map<number, KeyedDoc>();
  // Segments in parallel: a key is live in one of them at most.
  const found = await Promise.all(
    release.segments.map((seg) => {
      const want = keys.filter(
        (k) =>
          !seg.removed.has(k) &&
          k >= seg.reader.manifest.firstKey &&
          k <= seg.reader.manifest.lastKey,
      );
      return want.length === 0
        ? Promise.resolve(new Map<number, KeyedDoc>())
        : seg.reader.stored(want);
    }),
  );
  found.forEach((docs, si) => {
    const seg = release.segments[si] as OpenRelease["segments"][number];
    for (const [k, d] of docs) if (!seg.removed.has(k)) out.set(k, d);
  });
  return out;
}

async function storedOf(
  release: OpenRelease,
  keys: readonly number[],
  fields: readonly string[],
): Promise<Record<string, unknown>[]> {
  const map = await storedMap(release, keys);
  return keys
    .map((k) => map.get(k))
    .filter((d): d is KeyedDoc => d !== undefined)
    .map((d) => returned(d, fields));
}
