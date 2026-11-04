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
import { createLane, settle } from "#lib/streamed.js";
import { toEditPage } from "./edit-active-page.js";
import { loadLiveLinks } from "./live-links.js";
import { opErrorMessage } from "./op-error.js";
import { loadPageSeoInfo } from "./page-seo-info.js";
import { getQueryContext } from "./query.js";
import { SLOW_STEP_MS } from "./server-timing.js";
import { openStagingHref } from "./staging-link.js";
/** Starts every streamed read of the Live Edit load; returns their promises. */
export function streamEditorParts(input) {
    const { ctx, branchCtx, chatSessionId, activePage } = input;
    const toolbar = createLane();
    const picker = createLane();
    const banner = createLane();
    const run = (lane, what, step) => settle(what, () => lane(step), logSlowStep);
    // Main's version of the shown page: its title tells the SEO info whether
    // the draft changed it, its path where it is live. Absent = created in
    // the draft.
    let mainPage = null;
    const loadMainPage = () => {
        if (!activePage)
            return Promise.resolve(null);
        const known = input.mainCandidates.find((p) => p.id === activePage.id);
        if (known)
            return Promise.resolve(known);
        mainPage ??= read(ctx, "pages.list", {
            pageIds: [activePage.id],
        }).then((v) => v.pages[0] ?? null);
        return mainPage;
    };
    const branchChangeCount = run(toolbar, "The change count", async () => {
        const v = await read(ctx, "chat.branch_change_count", { chatSessionId });
        return v.count;
    });
    const deployState = run(toolbar, "The deploy state", () => loadDeployState(ctx));
    const live = run(toolbar, "The live links", async () => {
        const deploy = await deployState;
        if (!deploy.ok)
            throw new Error("the deploy state is missing");
        return loadLiveLinks(ctx, await loadMainPage(), deploy.value.productionMatchesStaging);
    });
    const pendingChanges = run(toolbar, "The Stage list", () => read(ctx, "chat.list_pending_changes", { chatSessionId }));
    const pageSeo = run(toolbar, "The page's SEO", async () => activePage
        ? loadPageSeoInfo(branchCtx, activePage, (await loadMainPage())?.title ?? null)
        : null);
    const recentPageIds = run(picker, "Recently edited pages", async () => {
        const v = await read(branchCtx, "pages.list_recently_edited", {
            limit: 8,
        });
        return v.pages.map((p) => p.pageId);
    });
    const pages = run(picker, "The page list", async () => input.branchPages
        ? [...input.branchPages]
        : (await read(branchCtx, "pages.list", {})).pages.map(toEditPage));
    const modules = run(picker, "The modules", async () => {
        const v = await read(branchCtx, "modules.list", {});
        return v.modules;
    });
    const branchEditedModuleIds = run(picker, "The changed modules", async () => {
        const v = await read(ctx, "chat.branch_edited_modules", {
            chatSessionId,
        });
        return v.moduleIds;
    });
    const otherOpenChats = run(banner, "Other open chats", async () => {
        const v = await read(ctx, "chat.list_open_with_pending", {
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
async function read(ctx, op, input) {
    const { adapter, registry } = getQueryContext();
    const r = await execute(registry, adapter, ctx, op, input);
    if (!r.ok) {
        console.error(`[edit] ${op} failed`, { error: r.error });
        throw new Error(opErrorMessage(r.error, `${op} failed`));
    }
    return r.value;
}
/** Streamed steps run after the response headers left: log the slow ones. */
function logSlowStep(step, ms, ok) {
    if (ms >= SLOW_STEP_MS)
        console.warn("[edit] slow streamed step", { step, ms: Math.round(ms), ok });
}
/** Reads the recent site builds and derives where staging and live stand. */
async function loadDeployState(ctx) {
    // #1155 — site builds only: plugin-data builds run every tick and would
    // push the last Stage and Publish live out of the window.
    const { runs } = await read(ctx, "deploy.list_runs", {
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
export function deployStateFromRuns(runs, stagingDomain) {
    // A failed staging build newer than every succeeded one means staging
    // lacks what that Stage was to carry.
    const newestStaging = runs.find((row) => row.targetName === "staging");
    const lastStageFailure = newestStaging?.status === "failed"
        ? {
            runId: newestStaging.id,
            error: newestStaging.errorMessage ?? "The staging build failed without a message.",
        }
        : null;
    const staged = runs.find((row) => row.targetName === "staging" && row.status === "succeeded" && row.finishedAt);
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
    const published = runs.find((row) => row.targetName === "production" && row.status === "succeeded" && row.finishedAt);
    const lastPublishedLive = published?.finishedAt
        ? {
            runId: published.id,
            finishedAt: published.finishedAt,
            fromRunId: published.buildId ?? null,
        }
        : null;
    const productionMatchesStaging = lastStaged && published?.buildId ? published.buildId === lastStaged.runId : null;
    return { lastStaged, lastPublishedLive, productionMatchesStaging, lastStageFailure };
}
