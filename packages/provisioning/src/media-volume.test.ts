// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's media volume: upgrade gives existing GCP installs the media
 * bucket as a Cloud Storage volume, the same shape the stacks deploy, and
 * adds only what a service is missing. Regression for media living on the
 * Cloud Run container's in-memory filesystem (lost on every new revision and
 * scale-to-zero; Stage then failed with "storage object missing").
 *
 * The service JSON below is what `gcloud run services describe --format=json`
 * returns (Knative serving.knative.dev/v1), i.e. the fake gcloud's describe
 * output for each install state.
 */

import { describe, expect, it } from "bun:test";
import {
  adminEnvContract,
  adminMediaVolume,
  adminMediaVolumeTemplate,
  databaseUrls,
  MEDIA_MOUNT_PATH,
} from "./stack-contract.js";
import { liveVolumes, planMediaVolume, serviceRollArgs } from "./stack-converge.js";

const BUCKET = "acme-caelo-production-media";
const desired = adminMediaVolume("acme", "production");

/** A described admin service with the given template parts. */
function describedAdmin(parts: {
  executionEnvironment?: string;
  volumes?: unknown[];
  mounts?: unknown[];
}): string {
  return JSON.stringify({
    apiVersion: "serving.knative.dev/v1",
    kind: "Service",
    metadata: { name: "caelo-production-admin-aaa" },
    spec: {
      template: {
        metadata: {
          annotations: {
            "autoscaling.knative.dev/maxScale": "3",
            ...(parts.executionEnvironment
              ? { "run.googleapis.com/execution-environment": parts.executionEnvironment }
              : {}),
          },
        },
        spec: {
          serviceAccountName: "caelo-production-run-sa@acme.iam.gserviceaccount.com",
          containers: [
            {
              image: "img@sha256:1",
              env: [{ name: "CAELO_PROVIDER", value: "gcp-firebase" }],
              ...(parts.mounts ? { volumeMounts: parts.mounts } : {}),
            },
          ],
          ...(parts.volumes ? { volumes: parts.volumes } : {}),
        },
      },
    },
  });
}

const gcsVolume = (bucket: string, extra: Record<string, unknown> = {}) => ({
  name: "media",
  csi: {
    driver: "gcsfuse.run.googleapis.com",
    volumeAttributes: { bucketName: bucket },
    ...extra,
  },
});
const mediaMount = { name: "media", mountPath: MEDIA_MOUNT_PATH };

/**
 * A fake `gcloud run services update` for the volume flags: applies them to
 * a described service the way Cloud Run does, and fails like gcloud on a
 * duplicate volume name or mount path.
 */
function fakeGcloudServicesUpdate(serviceJson: string, argv: readonly string[]): string {
  const svc = JSON.parse(serviceJson);
  const template = svc.spec.template;
  const container = template.spec.containers[0];
  const kv = (v: string) =>
    Object.fromEntries(v.split(",").map((p) => p.split("=") as [string, string]));
  // Accept both `--flag=value` and `--flag value`.
  const flags: [string, string][] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const eq = a.indexOf("=");
    if (eq > 0) flags.push([a.slice(0, eq), a.slice(eq + 1)]);
    else flags.push([a, argv[++i] ?? ""]);
  }
  for (const [flag, value] of flags) {
    if (flag === "--execution-environment") {
      template.metadata.annotations["run.googleapis.com/execution-environment"] = value;
    } else if (flag === "--add-volume") {
      const v = kv(value);
      template.spec.volumes ??= [];
      if (template.spec.volumes.some((x: { name: string }) => x.name === v.name)) {
        throw new Error(`ERROR: (gcloud.run.services.update) volume ${v.name} already exists`);
      }
      expect(v.type).toBe("cloud-storage");
      template.spec.volumes.push({
        name: v.name,
        csi: { driver: "gcsfuse.run.googleapis.com", volumeAttributes: { bucketName: v.bucket } },
      });
    } else if (flag === "--add-volume-mount") {
      const m = kv(value);
      container.volumeMounts ??= [];
      if (
        container.volumeMounts.some((x: { mountPath: string }) => x.mountPath === m["mount-path"])
      ) {
        throw new Error(`ERROR: (gcloud.run.services.update) mount path ${m["mount-path"]} in use`);
      }
      container.volumeMounts.push({ name: m.volume, mountPath: m["mount-path"] });
    } else {
      throw new Error(`fake gcloud: unexpected flag ${flag}`);
    }
  }
  return JSON.stringify(svc);
}

/** What the operator's manual hotfix leaves on the service. */
const HOTFIXED = describedAdmin({
  executionEnvironment: "gen2",
  volumes: [gcsVolume(BUCKET)],
  mounts: [mediaMount],
});

describe("admin media volume contract", () => {
  it("is the install's media bucket at the admin's default media root", () => {
    expect(desired).toEqual({
      volumeName: "media",
      bucket: BUCKET,
      mountPath: "/app/apps/admin/data/media",
    });
  });

  it("the stacks deploy it gen2, read-write, mounted on the admin container", () => {
    expect(adminMediaVolumeTemplate(desired)).toEqual({
      executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
      volumes: [{ name: "media", gcs: { bucket: BUCKET, readOnly: false } }],
      volumeMounts: [{ name: "media", mountPath: MEDIA_MOUNT_PATH }],
    });
  });

  it("the admin env points MEDIA_ROOT_DIR at the mount", () => {
    const env = adminEnvContract({
      provider: "gcp",
      projectId: "acme",
      env: "production",
      domain: "acme.com",
      region: "europe-west1",
      databaseUrls: databaseUrls("10.0.0.3"),
    });
    expect(env).toContainEqual({ name: "MEDIA_ROOT_DIR", value: MEDIA_MOUNT_PATH });
  });
});

describe("planMediaVolume (upgrade)", () => {
  it("regression: an install whose admin has no volume gets gen2 + the volume + the mount", () => {
    const plan = planMediaVolume(liveVolumes(describedAdmin({})), desired);
    expect(plan).toEqual({
      ok: true,
      flags: [
        "--execution-environment=gen2",
        `--add-volume=name=media,type=cloud-storage,bucket=${BUCKET}`,
        `--add-volume-mount=volume=media,mount-path=${MEDIA_MOUNT_PATH}`,
      ],
      changes: expect.any(Array),
    });
  });

  it("treats the operator's identical manual hotfix as converged (no flags, no new volume)", () => {
    expect(planMediaVolume(liveVolumes(HOTFIXED), desired)).toEqual({
      ok: true,
      flags: [],
      changes: [],
    });
  });

  it("is idempotent: once the fake gcloud applied the roll, the next upgrade adds nothing", () => {
    const first = planMediaVolume(liveVolumes(describedAdmin({})), desired);
    if (!first.ok) throw new Error(first.error);
    const rolled = fakeGcloudServicesUpdate(describedAdmin({}), first.flags);
    expect(planMediaVolume(liveVolumes(rolled), desired)).toEqual({
      ok: true,
      flags: [],
      changes: [],
    });
    // The upgrade flags and the operator's manual hotfix produce the same service.
    const hotfix = fakeGcloudServicesUpdate(describedAdmin({}), [
      "--execution-environment",
      "gen2",
      "--add-volume",
      `name=media,type=cloud-storage,bucket=${BUCKET}`,
      "--add-volume-mount",
      `volume=media,mount-path=${MEDIA_MOUNT_PATH}`,
    ]);
    expect(liveVolumes(rolled)).toEqual(liveVolumes(hotfix));
  });

  it("keeps operator mount options on an otherwise identical volume", () => {
    const live = describedAdmin({
      executionEnvironment: "gen2",
      volumes: [
        gcsVolume(BUCKET, {
          volumeAttributes: { bucketName: BUCKET, mountOptions: "implicit-dirs" },
        }),
      ],
      mounts: [mediaMount],
    });
    expect(planMediaVolume(liveVolumes(live), desired)).toEqual({
      ok: true,
      flags: [],
      changes: [],
    });
  });

  it("adds only what is missing", () => {
    const gen1 = describedAdmin({
      executionEnvironment: "gen1",
      volumes: [gcsVolume(BUCKET)],
      mounts: [mediaMount],
    });
    expect(planMediaVolume(liveVolumes(gen1), desired)).toMatchObject({
      ok: true,
      flags: ["--execution-environment=gen2"],
    });
    const noMount = describedAdmin({ executionEnvironment: "gen2", volumes: [gcsVolume(BUCKET)] });
    expect(planMediaVolume(liveVolumes(noMount), desired)).toMatchObject({
      ok: true,
      flags: [`--add-volume-mount=volume=media,mount-path=${MEDIA_MOUNT_PATH}`],
    });
  });

  it("refuses a media volume of another bucket instead of replacing it", () => {
    const live = describedAdmin({
      executionEnvironment: "gen2",
      volumes: [gcsVolume("other-bucket")],
      mounts: [mediaMount],
    });
    const plan = planMediaVolume(liveVolumes(live), desired);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error).toContain("other-bucket");
    expect(!plan.ok && plan.error).toContain(BUCKET);
  });

  it("refuses a read-only or non-Cloud-Storage media volume", () => {
    for (const volume of [
      gcsVolume(BUCKET, { readOnly: true }),
      { name: "media", emptyDir: { medium: "Memory" } },
    ]) {
      const live = describedAdmin({
        executionEnvironment: "gen2",
        volumes: [volume],
        mounts: [mediaMount],
      });
      expect(planMediaVolume(liveVolumes(live), desired).ok).toBe(false);
    }
  });

  it("refuses another volume at the media path, and the media volume mounted elsewhere", () => {
    const other = describedAdmin({
      volumes: [{ name: "scratch", emptyDir: {} }],
      mounts: [{ name: "scratch", mountPath: MEDIA_MOUNT_PATH }],
    });
    const otherPlan = planMediaVolume(liveVolumes(other), desired);
    expect(!otherPlan.ok && otherPlan.error).toContain('volume "scratch"');
    const elsewhere = describedAdmin({
      executionEnvironment: "gen2",
      volumes: [gcsVolume(BUCKET)],
      mounts: [{ name: "media", mountPath: "/mnt/media" }],
    });
    const elsewherePlan = planMediaVolume(liveVolumes(elsewhere), desired);
    expect(!elsewherePlan.ok && elsewherePlan.error).toContain("/mnt/media");
  });

  it("rides the image roll's single services update", () => {
    const plan = planMediaVolume(liveVolumes(describedAdmin({})), desired);
    if (!plan.ok) throw new Error(plan.error);
    const args = serviceRollArgs({
      serviceName: "caelo-production-admin-aaa",
      region: "europe-west1",
      projectId: "acme",
      imageRef: "img@sha256:1",
      serviceAccount: "caelo-production-run-sa@acme.iam.gserviceaccount.com",
      envFlags: [`--update-env-vars=MEDIA_ROOT_DIR=${MEDIA_MOUNT_PATH}`],
      volumeFlags: plan.flags,
    });
    expect(args.slice(0, 3)).toEqual(["run", "services", "update"]);
    for (const f of plan.flags) expect(args).toContain(f);
    expect(args.at(-1)).toBe("--quiet");
  });
});
