// SPDX-License-Identifier: MPL-2.0

/**
 * #1268 — what Live Edit loads after first paint.
 *
 * Opening the editor once awaited about twenty reads in a row. One of them,
 * `chat.list_open_with_pending`, ran into the 60 s statement timeout on a
 * large shared draft (searchVIU, 2026-10-30/31), so the operator saw
 * nothing for a minute. First paint now waits only for the page, the
 * chat and its transcript (`edit/+page.server.ts`); everything here
 * streams in, and a part that fails says so where it would show
 * (`Streamed`, CLAUDE.md §2).
 *
 * The reads run in three lanes, each step after the previous one:
 *   - toolbar: the change count, deploy state, "View live", the Stage
 *     list and the page's SEO;
 *   - picker: recently edited pages, the page list, the modules;
 *   - banner: the other open chats, which grow with the draft and must not
 *     hold up the toolbar.
 * A load then holds at most three pooled connections, not ten.
 */

import { providerHasStagingDomain } from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import type { ChatModule } from "#lib/components/chat/types.js";
import { createLane, type Streamed, settle } from "#lib/streamed.js";
import { type EditPage, toEditPage } from "./edit-active-page.js";
import { type LiveLinks, loadLiveLinks } from "./live-links.js";
import { opErrorMessage } from "./op-error.js";
import { loadPageSeoInfo, type PageSeoInfo } from "./page-seo-info.js";
import { getQueryContext } from "./query.js";
import { SLOW_STEP_MS } from "./server-timing.js";
import { openStagingHref } from "./staging-link.js";

/** One entry of the Stage list. */
export interface PendingEntity {
  readonly kind: string;
  readonly entityId: string;
  readonly label: string;
  readonly detail?: string;
}

/** What the chat changed, pending vs staged, per Stage list group. */
export interface PendingChangesView {
  readonly pending: {
    pages: PendingEntity[];
    globals: PendingEntity[];
    lists: PendingEntity[];
  };
  readonly staged: {
    pages: PendingEntity[];
    globals: PendingEntity[];
    lists: PendingEntity[];
  };
}

/** Another open chat with unstaged changes, for the cross-chat banner. */
export interface OtherOpenChat {
  readonly chatSessionId: string;
  readonly title: string;
  readonly anchorPageId: string | null;
  readonly anchorPagePath: string | null;
  readonly pendingCount: number;
}

/** Where staging and live stand, for the Staging and Publish live controls. */
export interface DeployState {
  /** v0.8.0 — the last succeeded staging build, for the Promote dialog header. */
  readonly lastStaged: { runId: string; finishedAt: string; previewUrl: string | null } | null;
  /** v0.10.12 — the last succeeded production deploy. */
  readonly lastPublishedLive: {
    runId: string;
    finishedAt: string;
    fromRunId: string | null;
  } | null;
  /** Whether live carries the last staged build; null when either is missing. */
  readonly productionMatchesStaging: boolean | null;
  /** #1207 — the newest staging build when it failed: Publish live then closes. */
  readonly lastStageFailure: { runId: string; error: string } | null;
}

/** The streamed parts of the Live Edit load. */
export interface EditorStream {
  readonly pages: Promise<Streamed<EditPage[]>>;
  /** #1207 — what the page search offers before anything is typed. */
  readonly recentPageIds: Promise<Streamed<string[]>>;
  readonly modules: Promise<Streamed<ChatModule[]>>;
  /** P6.6 — the modules this chat changed, for the Diff panel. */
  readonly branchEditedModuleIds: Promise<Streamed<string[]>>;
  /** v0.2.76 — distinct entities this chat changed: the Diff count and Stage. */
  readonly branchChangeCount: Promise<Streamed<number>>;
  readonly pendingChanges: Promise<Streamed<PendingChangesView>>;
  readonly otherOpenChats: Promise<Streamed<OtherOpenChat[]>>;
  readonly deployState: Promise<Streamed<DeployState>>;
  /** "View live" in the Publish live menu. */
  readonly live: Promise<Streamed<LiveLinks>>;
  /** #1156 — the shown page's SEO in this chat's view; null without a page. */
  readonly pageSeo: Promise<Streamed<PageSeoInfo | { readonly error: string } | null>>;
}

export interface EditorStreamInput {
  /** The operator's context (chat ops resolve the chat's own binding). */
  readonly ctx: ExecutionContext;
  /** The operator's context in the chat's branch view. */
  readonly branchCtx: ExecutionContext;
  readonly chatSessionId: string;
  /** The page first paint opened, in the branch view; null on an empty site. */
  readonly activePage: EditPage | null;
  /** The pages main has among the first-paint lookup, to find main's version. */
  readonly mainCandidates: readonly EditPage[];
  /** The branch's whole page list, when first paint already had to read it. */
  readonly branchPages: readonly EditPage[] | null;
}

/** Starts every streamed read of the Live Edit load; returns their promises. */
export function streamEditorParts(input: EditorStreamInput): EditorStream {
  const { ctx, branchCtx, chatSessionId, activePage } = input;
  const toolbar = createLane();
  const picker = createLane();
  const banner = createLane();
  const run = <T>(lane: ReturnType<typeof createLane>, what: string, step: () => Promise<T>) =>
    settle(what, () => lane(step), logSlowStep);

  // Main's version of the shown page: its title tells the SEO info whether
  // the draft changed it, its path where it is live. Absent = created in
  // the draft.
  let mainPage: Promise<EditPage | null> | null = null;
  const loadMainPage = (): Promise<EditPage | null> => {
    if (!activePage) return Promise.resolve(null);
    const known = input.mainCandidates.find((p) => p.id === activePage.id);
    if (known) return Promise.resolve(known);
    mainPage ??= read<{ pages: EditPage[] }>(ctx, "pages.list", {
      pageIds: [activePage.id],
    }).then((v) => v.pages[0] ?? null);
    return mainPage;
  };

  const branchChangeCount = run(toolbar, "The change count", async () => {
    const v = await read<{ count: number }>(ctx, "chat.branch_change_count", { chatSessionId });
    return v.count;
  });
  const deployState = run(toolbar, "The deploy state", () => loadDeployState(ctx));
  const live = run(toolbar, "The live links", async () => {
    const deploy = await deployState;
    if (!deploy.ok) throw new Error("the deploy state is missing");
    return loadLiveLinks(ctx, await loadMainPage(), deploy.value.productionMatchesStaging);
  });
  const pendingChanges = run(toolbar, "The Stage list", () =>
    read<PendingChangesView>(ctx, "chat.list_pending_changes", { chatSessionId }),
  );
  const pageSeo = run(toolbar, "The page's SEO", async () =>
    activePage
      ? loadPageSeoInfo(branchCtx, activePage, (await loadMainPage())?.title ?? null)
      : null,
  );

  const recentPageIds = run(picker, "Recently edited pages", async () => {
    const v = await read<{ pages: { pageId: string }[] }>(branchCtx, "pages.list_recently_edited", {
      limit: 8,
    });
    return v.pages.map((p) => p.pageId);
  });
  const pages = run(picker, "The page list", async () =>
    input.branchPages
      ? [...input.branchPages]
      : (await read<{ pages: EditPage[] }>(branchCtx, "pages.list", {})).pages.map(toEditPage),
  );
  const modules = run(picker, "The modules", async () => {
    const v = await read<{ modules: ChatModule[] }>(branchCtx, "modules.list", {});
    return v.modules;
  });
  const branchEditedModuleIds = run(picker, "The changed modules", async () => {
    const v = await read<{ moduleIds: string[] }>(ctx, "chat.branch_edited_modules", {
      chatSessionId,
    });
    return v.moduleIds;
  });

  const otherOpenChats = run(banner, "Other open chats", async () => {
    const v = await read<{ chats: OtherOpenChat[] }>(ctx, "chat.list_open_with_pending", {
      excludeChatSessionId: chatSessionId,
    });
    return v.chats;
  });

  return {
    pages,
    recentPageIds,
    modules,
    branchEditedModuleIds,
    branchChangeCount,
    pendingChanges,
    otherOpenChats,
    deployState,
    live,
    pageSeo,
  };
}

/** Runs one op; a refusal throws with the op's operator-readable reason, and is logged. */
async function read<T>(ctx: ExecutionContext, op: string, input: unknown): Promise<T> {
  const { adapter, registry } = getQueryContext();
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) {
    console.error(`[edit] ${op} failed`, { error: r.error });
    throw new Error(opErrorMessage(r.error, `${op} failed`));
  }
  return r.value as T;
}

/** Streamed steps run after the response headers left: log the slow ones. */
function logSlowStep(step: string, ms: number, ok: boolean): void {
  if (ms >= SLOW_STEP_MS)
    console.warn("[edit] slow streamed step", { step, ms: Math.round(ms), ok });
}

interface DeployRunRow {
  id: string;
  targetName: string;
  status: string;
  finishedAt: string | null;
  buildId: string | null;
  errorMessage: string | null;
  publishSummary?: { previewUrl?: string };
}

/** Reads the recent site builds and derives where staging and live stand. */
async function loadDeployState(ctx: ExecutionContext): Promise<DeployState> {
  // #1155 — site builds only: plugin-data builds run every tick and would
  // push the last Stage and Publish live out of the window.
  const { runs } = await read<{ runs: DeployRunRow[] }>(ctx, "deploy.list_runs", {
    limit: 20,
    buildKind: "site",
  });
  return deployStateFromRuns(runs, providerHasStagingDomain(process.env.CAELO_PROVIDER));
}

/**
 * Where staging and live stand, from site build runs newest first.
 *
 * @param stagingDomain - #650: the install serves staging at staging.<domain>,
 *   so "Open staging" links there and never to the provider's preview origin.
 */
export function deployStateFromRuns(
  runs: readonly DeployRunRow[],
  stagingDomain: boolean,
): DeployState {
  // A failed staging build newer than every succeeded one means staging
  // lacks what that Stage was to carry.
  const newestStaging = runs.find((row) => row.targetName === "staging");
  const lastStageFailure =
    newestStaging?.status === "failed"
      ? {
          runId: newestStaging.id,
          error: newestStaging.errorMessage ?? "The staging build failed without a message.",
        }
      : null;
  const staged = runs.find(
    (row) => row.targetName === "staging" && row.status === "succeeded" && row.finishedAt,
  );
  const lastStaged = staged?.finishedAt
    ? {
        runId: staged.id,
        finishedAt: staged.finishedAt,
        previewUrl: stagingDomain
          ? openStagingHref("/")
          : (staged.publishSummary?.previewUrl ?? null),
      }
    : null;
  // deploy.promote stamps the source staging run id into the production
  // run's build_id; a direct production build has a fresh one. Matching
  // ids = live carries the last staged build.
  const published = runs.find(
    (row) => row.targetName === "production" && row.status === "succeeded" && row.finishedAt,
  );
  const lastPublishedLive = published?.finishedAt
    ? {
        runId: published.id,
        finishedAt: published.finishedAt,
        fromRunId: published.buildId ?? null,
      }
    : null;
  const productionMatchesStaging =
    lastStaged && published?.buildId ? published.buildId === lastStaged.runId : null;
  return { lastStaged, lastPublishedLive, productionMatchesStaging, lastStageFailure };
}
