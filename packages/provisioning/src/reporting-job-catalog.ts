// SPDX-License-Identifier: MPL-2.0

/**
 * #1646 (epic #1644) — one declaration per kind of reporting job. A
 * reporting job (#1359) runs bounded work outside the admin and reports
 * back by request: a Stage's quality audit, a site import's crawl, a
 * carried build, a Stage's collection index, a plugin's batch run. Each
 * kind is ONE entry of {@link REPORTING_JOB_CATALOG}: its names, the admin
 * env vars that point at it, its machine, its grants beyond the shared
 * line, what must exist before it can be set up, and how the CLI talks
 * about it. Everything that sets up, moves or grants jobs iterates the
 * catalog: the admin's env contract, the wizard, every converge, the
 * app-roll's image move, the upgrader's actAs, its IAM pre-flight and the
 * operator-access IAP list. A new kind is one entry here plus its kind in
 * admin-core (reporting-jobs/kinds.ts; the scripts parity test pins the env
 * var names of both).
 *
 * Outside the catalog stay the two jobs that are not reporting jobs: the
 * Lighthouse audit job (audit-job-setup.ts: parallel tasks, a results
 * bucket, no IAP access) and the capture job (capture-job-setup.ts: renders
 * untrusted pages, so no IAP access and no read right anywhere). Their
 * trust line differs from the shared one, so folding them in would change
 * what they may do.
 *
 * Pure module: stack-contract.ts (the admin's env contract) imports it.
 * The setup itself is reporting-job-setup.ts.
 */

import { COLLECTIONS_STAGING_STORE_ENV, gcpCollectionStore } from "./collection-stores.js";
import {
  auditJobName,
  auditJobResource,
  gcpBucketName,
  reportingJobAccountId,
} from "./gcp-names.js";
import type { GcpProvider } from "./stack-contract.js";

/** Where a kind's job goes. */
export interface ReportingJobPlace {
  readonly provider: GcpProvider;
  readonly projectId: string;
  readonly region: string;
  /** Pulumi stack name (`production`). */
  readonly env: string;
}

/** What one kind of reporting job needs beyond the shared grants. */
export interface ReportingJobSpec {
  /** How the CLI names it ("quality-audit runner"). */
  readonly label: string;
  readonly jobName: string;
  readonly serviceAccountId: string;
  readonly displayName: string;
  readonly description: string;
  /** The job's env (`KEY=value`; never a secret). */
  readonly env: readonly string[];
  readonly cpu: string;
  readonly memory: string;
  /** One execution's ceiling (admin-core protocol.ts `JOB_TIMING.maxRunSeconds`). */
  readonly taskTimeoutSeconds: number;
  /** Read-only bucket access it needs, each with the reason. */
  readonly readBuckets: readonly { readonly bucket: string; readonly why: string }[];
  /**
   * Buckets it creates objects in (`roles/storage.objectCreator`: create
   * only, no overwrite, no delete, no read — pair it with a read bucket when
   * the job reads there too), each with the reason. Reviewed per kind: only
   * the collection index job has one.
   */
  readonly writeBuckets: readonly { readonly bucket: string; readonly why: string }[];
  /** Jobs it starts itself, with its order as an override (and reads their executions). */
  readonly runJobs: readonly { readonly job: string; readonly why: string }[];
}

/** What a kind declares of its job; the catalog adds its label and names. */
export type ReportingKindJob = Omit<ReportingJobSpec, "label" | "jobName" | "serviceAccountId">;

/** What a kind's setup waits for: its step comes after that one, and is skipped without it. */
export type ReportingJobPrerequisite =
  /** The Lighthouse audit job (audit-job-setup.ts), whose tasks it starts. */
  | "audit-job"
  /** The collection stores (collections-setup.ts), where it reads and writes. */
  | "collection-stores";

/** One kind of reporting job. */
export interface ReportingJobKindEntry {
  /** The kind's name in admin-core (reporting-jobs/protocol.ts `REPORTING_JOB_KINDS`). */
  readonly kind: string;
  /** The issue that added it, for the CLI's history lines. */
  readonly issue: string;
  /**
   * Job name and service-account id suffix: `caelo-<env>-<name>`. An
   * account id has at most 30 characters (the catalog test checks it for
   * every stack env).
   */
  readonly name: string;
  /** The admin env var naming the job (`projects/<p>/locations/<r>/jobs/<j>`). */
  readonly jobEnvVar: string;
  /** The admin env var naming the one account whose reports the admin takes for it. */
  readonly serviceAccountEnvVar: string;
  /** How the CLI names it ("quality-audit runner"). */
  readonly label: string;
  readonly prerequisite: ReportingJobPrerequisite | null;
  /** Its job: machine, env and grants beyond the shared line. */
  readonly job: (place: ReportingJobPlace) => ReportingKindJob;
  /** The wizard's spinner lines. */
  readonly wizard: { readonly starting: string; readonly ready: string };
  /** The converge's step lines, and what fails until it succeeds. */
  readonly converge: {
    readonly step: string;
    readonly ready: string;
    readonly consequence: string;
  };
  /** What fails while its image lags behind the admin's (upgrade/admin-image-jobs.ts). */
  readonly lagging: string;
}

/** `caelo-<env>-<name>`: the kind's job name. */
export function reportingJobName(entry: Pick<ReportingJobKindEntry, "name">, env: string): string {
  return reportingJobAccountId(env, entry.name);
}

/** The job's full resource name, as the admin's env carries it. */
export function reportingJobResource(
  entry: Pick<ReportingJobKindEntry, "name">,
  projectId: string,
  region: string,
  env: string,
): string {
  return `projects/${projectId}/locations/${region}/jobs/${reportingJobName(entry, env)}`;
}

/** The kind's service account email. */
export function reportingJobServiceAccountEmail(
  entry: Pick<ReportingJobKindEntry, "name">,
  projectId: string,
  env: string,
): string {
  return `${reportingJobAccountId(env, entry.name)}@${projectId}.iam.gserviceaccount.com`;
}

/**
 * The audit runner (#1359): the whole quality audit of a Stage. It serves
 * the staged build from its staging slot to its own findings checks, starts
 * the Lighthouse tasks on the audit job (#875) and reads their results.
 */
function auditRunnerJob(place: ReportingJobPlace): ReportingKindJob {
  const { projectId, region, env, provider } = place;
  const staging = gcpBucketName(projectId, env, "staging");
  const results = gcpBucketName(projectId, env, "audit-results");
  return {
    displayName: "Caelo quality-audit runner",
    description:
      "Runs a Stage's quality audit and reports to the admin; reads the staged build and the Lighthouse results, starts the Lighthouse tasks, nothing else.",
    env: [
      `CAELO_PROVIDER=${provider}`,
      `CAELO_STAGING_BUCKET=${staging}`,
      `CAELO_AUDIT_JOB=${auditJobResource(projectId, region, env)}`,
      `CAELO_AUDIT_RESULTS_BUCKET=${results}`,
    ],
    cpu: "1",
    memory: "2Gi",
    // admin-core JOB_TIMING.quality_audit.maxRunSeconds.
    taskTimeoutSeconds: 3600,
    readBuckets: [
      { bucket: staging, why: "it serves the staged build to the findings checks" },
      { bucket: results, why: "it reads the Lighthouse tasks' results" },
    ],
    writeBuckets: [],
    runJobs: [{ job: auditJobName(env), why: "it starts the Lighthouse tasks" }],
  };
}

/**
 * The site-import crawler (#1360): one site import's crawl. It reads
 * third-party pages, so it holds nothing beyond the shared grants: no
 * bucket, no other job. It fetches robots.txt and sitemaps itself, through
 * the SSRF guard; every page render is the admin's, which starts the
 * capture job and keeps the screenshot, so the crawler never runs a
 * browser and never touches the capture job or its bucket.
 */
function importCrawlJob(place: ReportingJobPlace): ReportingKindJob {
  return {
    displayName: "Caelo site-import crawler",
    description:
      "Crawls a site the Owner approved for import and reports each page to the admin; fetches robots.txt and sitemaps through the SSRF guard, nothing else.",
    env: [`CAELO_PROVIDER=${place.provider}`],
    cpu: "1",
    // The frontier and up to four rendered pages' HTML at once.
    memory: "2Gi",
    // admin-core JOB_TIMING.site_import.maxRunSeconds: a longer crawl goes
    // on in the next attempt, from its checkpoint.
    taskTimeoutSeconds: 6 * 3600,
    readBuckets: [],
    writeBuckets: [],
    runJobs: [],
  };
}

/**
 * The build carrier (#1574): one Stage's, Publish live's or production
 * build's request. It sends one report, `run`, and the admin runs the build
 * inside that request on its own database and rights, so the carrier holds
 * nothing beyond the shared grants: it reads nothing, fetches nothing,
 * builds nothing. Smallest machine: it only waits for the answer.
 */
function buildCarrierJob(place: ReportingJobPlace): ReportingKindJob {
  return {
    displayName: "Caelo build carrier",
    description:
      "Holds the admin request a Stage, Publish live or production build runs in, so the build ends when nobody waits for it; reports to the admin, nothing else.",
    env: [`CAELO_PROVIDER=${place.provider}`],
    cpu: "1",
    memory: "512Mi",
    // admin-core JOB_TIMING.build.maxRunSeconds: the admin's request limit
    // (the build stops two minutes before it) plus room to start and end.
    taskTimeoutSeconds: 3600 + 5 * 60,
    readBuckets: [],
    writeBuckets: [],
    runJobs: [],
  };
}

/**
 * Epic #1644 (R2, #1648) — the collection index job: the plugin collection
 * releases of a Stage. It asks the admin which collections changed, reads
 * their change files and previous releases from the staging collection
 * store, writes the new release's files there (each content-named and
 * written once, so create-only access is enough) and reports each release.
 * It holds no database credential and no secret; the bucket is the only
 * thing it reaches beyond the shared grants, and nothing of the live store.
 * Sized for a 50,000-page rebuild with on-CPU embeddings (R7): 2 vCPU, 4 GiB.
 */
function collectionIndexJob(place: ReportingJobPlace): ReportingKindJob {
  const store = gcpBucketName(place.projectId, place.env, "coll-staging");
  return {
    displayName: "Caelo collection index job",
    description:
      "Builds a Stage's plugin collection releases and reports them to the admin; reads and creates files in the staging collection store, nothing else.",
    env: [
      `CAELO_PROVIDER=${place.provider}`,
      `${COLLECTIONS_STAGING_STORE_ENV}=${gcpCollectionStore(place.projectId, place.env, "staging")}`,
    ],
    cpu: "2",
    memory: "4Gi",
    // admin-core JOB_TIMING.collection_index.maxRunSeconds: a large index
    // on the few tasks a small CPU quota leaves runs for hours.
    taskTimeoutSeconds: 6 * 3600,
    readBuckets: [
      { bucket: store, why: "it reads the Stage's change files and the previous releases" },
    ],
    writeBuckets: [{ bucket: store, why: "it writes the new releases' files" }],
    runJobs: [],
  };
}

/**
 * Epic #1644 (R5, #1646) — the plugin batch job: one run of a plugin's
 * declared batch operation (a backfill, say), its code in the Deno sandbox
 * inside the job. It holds the shared grants and nothing else: no bucket,
 * no other job, no database, no secret. Every storage or collection call
 * the plugin makes goes to the admin as a report, where the plugin's
 * grants and the host's rules decide it, as for any plugin call. 2 GiB:
 * the sandbox's heap (256 MiB) next to Bun and the batches in flight.
 */
function pluginBatchJob(place: ReportingJobPlace): ReportingKindJob {
  return {
    displayName: "Caelo plugin batch job",
    description:
      "Runs a plugin's batch operation in the plugin sandbox and reports every call it makes to the admin; reaches nothing else.",
    env: [`CAELO_PROVIDER=${place.provider}`],
    cpu: "1",
    memory: "2Gi",
    // admin-core JOB_TIMING.plugin_batch.maxRunSeconds plus room to start and end.
    taskTimeoutSeconds: 3600 + 5 * 60,
    readBuckets: [],
    writeBuckets: [],
    runJobs: [],
  };
}

/**
 * Every kind, in setup order: the wizard and the converge set them up in
 * this order, the admin's env lists them in it, and the app-roll moves
 * them in it (after the audit and capture jobs).
 */
export const REPORTING_JOB_CATALOG: readonly ReportingJobKindEntry[] = [
  {
    kind: "quality_audit",
    issue: "#1359",
    name: "audit-run",
    jobEnvVar: "CAELO_AUDIT_RUNNER_JOB",
    serviceAccountEnvVar: "CAELO_AUDIT_RUNNER_SERVICE_ACCOUNT",
    // It starts the Lighthouse tasks: its run grant is on that job.
    prerequisite: "audit-job",
    label: "quality-audit runner",
    job: auditRunnerJob,
    wizard: {
      starting: "Setting up the quality-audit runner (audits outside the admin)...",
      ready: "Quality-audit runner ready",
    },
    converge: {
      step: "Ensuring the quality-audit runner (audits outside the admin)...",
      ready: "Quality-audit runner ready (Stage audits run in their own job)",
      consequence: "Stage audits fail after their last attempt",
    },
    lagging: "Stage audits wait for it and fail after their last attempt",
  },
  {
    kind: "site_import",
    issue: "#1360",
    name: "import",
    jobEnvVar: "CAELO_IMPORT_CRAWL_JOB",
    serviceAccountEnvVar: "CAELO_IMPORT_CRAWL_SERVICE_ACCOUNT",
    prerequisite: null,
    label: "site-import crawler",
    job: importCrawlJob,
    wizard: {
      starting: "Setting up the site-import crawler (crawls outside the admin)...",
      ready: "Site-import crawler ready",
    },
    converge: {
      step: "Ensuring the site-import crawler (crawls outside the admin)...",
      ready: "Site-import crawler ready (site imports crawl in their own job)",
      consequence: "site imports fail after their last attempt",
    },
    lagging: "site imports wait for it and fail after their last attempt",
  },
  {
    kind: "build",
    issue: "#1574",
    name: "build",
    jobEnvVar: "CAELO_BUILD_CARRIER_JOB",
    serviceAccountEnvVar: "CAELO_BUILD_CARRIER_SERVICE_ACCOUNT",
    prerequisite: null,
    label: "build carrier",
    job: buildCarrierJob,
    wizard: {
      starting: "Setting up the build carrier (builds that outlast their request)...",
      ready: "Build carrier ready",
    },
    converge: {
      step: "Ensuring the build carrier (builds that outlast their request)...",
      ready: "Build carrier ready (a build nobody waits for still ends)",
      consequence:
        "an agent's Stage and every Stage or Publish live button fail at once with this reason",
    },
    lagging: "an agent's Stage and the Stage and Publish live buttons fail (Stage again)",
  },
  {
    kind: "collection_index",
    issue: "#1648",
    name: "index",
    jobEnvVar: "CAELO_COLLECTION_INDEX_JOB",
    serviceAccountEnvVar: "CAELO_COLLECTION_INDEX_SERVICE_ACCOUNT",
    // It reads and writes the staging collection store.
    prerequisite: "collection-stores",
    label: "collection index job",
    job: collectionIndexJob,
    wizard: {
      starting: "Setting up the collection index job (a Stage's search index outside the admin)...",
      ready: "Collection index job ready",
    },
    converge: {
      step: "Ensuring the collection index job (a Stage's search index outside the admin)...",
      ready: "Collection index job ready (a Stage's plugin indexes build in their own job)",
      consequence: "a Stage's plugin collections (a site search) fail after their last attempt",
    },
    lagging: "a Stage's plugin collections fail after their last attempt (Stage again)",
  },
  {
    kind: "plugin_batch",
    issue: "#1646",
    name: "plugin-batch",
    jobEnvVar: "CAELO_PLUGIN_BATCH_JOB",
    serviceAccountEnvVar: "CAELO_PLUGIN_BATCH_SERVICE_ACCOUNT",
    prerequisite: null,
    label: "plugin batch job",
    job: pluginBatchJob,
    wizard: {
      starting: "Setting up the plugin batch job (plugins' batch runs outside the admin)...",
      ready: "Plugin batch job ready",
    },
    converge: {
      step: "Ensuring the plugin batch job (plugins' batch runs outside the admin)...",
      ready: "Plugin batch job ready (a plugin's batch run has its own job)",
      consequence: "plugins' batch runs (backfills) fail after their last attempt",
    },
    lagging: "plugins' batch runs fail after their last attempt",
  },
];

/** The full spec of `entry`'s job at `place`: what reporting-job-setup.ts sets up. */
export function reportingJobSpec(
  entry: ReportingJobKindEntry,
  place: ReportingJobPlace,
): ReportingJobSpec {
  return {
    label: entry.label,
    jobName: reportingJobName(entry, place.env),
    serviceAccountId: reportingJobAccountId(place.env, entry.name),
    ...entry.job(place),
  };
}

/** The catalog entry of `kind`; throws for a kind it does not have. */
export function reportingJobEntry(kind: string): ReportingJobKindEntry {
  const entry = REPORTING_JOB_CATALOG.find((e) => e.kind === kind);
  if (!entry) throw new Error(`no reporting job kind "${kind}" in the catalog`);
  return entry;
}

/** Every kind's pair of admin env vars, in catalog order (stack-contract.ts adminEnvContract). */
export function reportingJobAdminEnv(
  projectId: string,
  region: string,
  env: string,
): { readonly name: string; readonly value: string }[] {
  return REPORTING_JOB_CATALOG.flatMap((e) => [
    { name: e.jobEnvVar, value: reportingJobResource(e, projectId, region, env) },
    { name: e.serviceAccountEnvVar, value: reportingJobServiceAccountEmail(e, projectId, env) },
  ]);
}

/** Every kind's service account email: the upgrader's actAs, the operator-access IAP list. */
export function reportingJobServiceAccounts(projectId: string, env: string): string[] {
  return REPORTING_JOB_CATALOG.map((e) => reportingJobServiceAccountEmail(e, projectId, env));
}
