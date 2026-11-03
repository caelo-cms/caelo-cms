# The converge job grants its own roles

Maintainer decision 2026-11-03. A Caelo release that changes the cloud
setup installs from Settings → Updates through the converge job
(`caelo-<env>-converge`, CLAUDE.md §11.C). When that release needs a
project role the job's account does not hold yet, the job grants the role
to itself. Before this change it stopped with "Needs one step from you —
run from Cloud Shell".

## Why

A release may add a role to `INSTALL_JOB_ROLES`
(`packages/provisioning/src/install-job.ts`). 0.11.11 added
`roles/workflows.editor`, so the scheduler tick (#1140) could deploy its
workflow. New installs get the role at install time, and every converge's
`ensureConvergeJob` grants it. But the converge job checks its access
(`converge-job-preflight.ts`) before it gets that far, and an older install
lacks the role. So the check refused, and the only way out was a terminal
run whose sole job was this one grant. searchviu-website hit this on
0.11.10 → 0.11.11.

This adds no privilege. The job's account is the install's
`caelo-provisioner`, and it has held `roles/resourcemanager.projectIamAdmin`
since install, so it could already grant itself any project role. The
allowlist only narrows what the job does with that right.

## The rules

- **What may be granted:** only `CONVERGE_SELF_GRANTABLE_ROLES`, which is
  `INSTALL_JOB_ROLES` as compiled into the release that runs. Nothing a
  request row, install.json, the environment or the manifest names can add
  a role. `SELF_GRANT_FORBIDDEN_ROLES` (owner, editor,
  `resourcemanager.*`, `iam.securityAdmin`, key, org-policy and billing
  roles) is checked twice: by the tests against the list, and again at run
  time by `isSelfGrantableRole`.
- **To whom:** the `caelo-provisioner` principal only, at project level,
  with no condition. `selfGrantArgs` (`converge-job-gcp.ts`) builds the
  member from the project id. It takes no principal.
- **When:** the job counts a missing permission as fixable only when it
  belongs to a check marked with an allowlisted role (`selfGrantPlan`). If
  anything else is missing too, the run stops as before, with every
  missing permission named, and it grants nothing.
  - **Stage 1** (the installed release's image) grants nothing. It writes
    to the timeline which roles are missing and hands the request over to
    the target release.
  - **Stage 2** (the target release's image) grants the roles only after
    it has checked that the image it runs is the one the manifest signs,
    holds the state lock, and has found install.json unchanged. All of
    this happens before the checkpoint and before any change to the site.
- **Timeline:** each grant is one success event, for example: *"Granted
  roles/workflows.editor to the converge job's account
  (caelo-provisioner@…), needed by Caelo <version> to deploy and update the
  workflow the scheduler tick runs (#1140)."* After the grants the job asks
  IAM again, every 15 s for up to about 8 minutes, because a policy change
  can take up to 7 minutes to apply.
- **When a grant fails** (an org policy, for example): the request ends
  `needs_cloud_shell` with code `iam-self-grant` and the existing "run the
  update once from Cloud Shell or the computer you installed from"
  message. It ends the same way when IAM still does not confirm the roles
  after the wait.
- **The upgrader job** (app-roll releases) has no grant step and holds no
  IAM right. `UPGRADER_FORBIDDEN_ROLES` is unchanged.

## What installs on v0.11.10 see

Each stage's code comes from a different release: stage 1 runs the code
of whatever ops image the converge job currently runs, and stage 2 runs
the target release's code. Old code cannot be changed after the fact, so
what happens depends on that image:

- **The converge job still runs v0.11.10's ops image** (the install has
  never asked Caelo for 0.11.11). Update straight to the release that
  contains this change, or any later one. v0.11.10's stage-1 check lists
  only `iam.roleAdmin`, `cloudscheduler.admin` and `logging.logWriter`
  (verified at tag `v0.11.10`) and does not check `workflows.*`. It passes
  and hands over. The new release's stage 2 then grants
  `roles/workflows.editor` and converges. No Cloud Shell. If the Owner
  picks 0.11.11 as the target instead, 0.11.11's own stage 2 refuses as
  before, because it has no self-grant.
- **The install already tried 0.11.11 from Caelo** (searchviu-website).
  v0.11.10's stage 1 pointed the converge job at 0.11.11's ops image
  before 0.11.11's stage 2 refused, and nothing points it back. Every
  later request therefore runs 0.11.11's stage 1. Its check lists
  `roles/workflows.editor` and refuses, whatever the target is. Such an
  install needs **one** run from Cloud Shell or the install laptop, best
  straight to the newest release. That run re-runs `ensureConvergeJob`,
  which grants the role and points the job at the new release's image.
  From then on, cloud-setup updates install from Caelo again.
- **Installs on the release with this change or later:** a role that a
  newer release adds is granted by that release's stage 2. The older
  stage 1 holding it back is no longer a problem either, because from
  this release on stage 1 leaves allowlisted roles to stage 2.
