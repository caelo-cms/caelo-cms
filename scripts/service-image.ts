// SPDX-License-Identifier: MPL-2.0

/**
 * Minimal service images (issue #1327): stage a bundled service for its
 * runtime image, and check that an image holds nothing else.
 *
 * A public-facing service (the API gateway today, the MCP auth proxy next)
 * must not ship the monorepo: every unused package and the shell are attack
 * surface after an RCE (CLAUDE.md §11.B Tier 3). The pattern:
 *
 *   - the Dockerfile's builder stage installs and builds the workspace as
 *     before, then runs `bun scripts/service-image.ts stage <spec> /stage`;
 *   - `stage` bundles the service's entry points with Bun (target bun, ESM,
 *     shared chunks), copies the exact `node_modules` packages the spec
 *     names (the run-time closure of its `runtimePackages`, refused when the
 *     two differ) and the spec's extra files, all under `/stage/app`;
 *   - the runtime stage is a digest-pinned distroless base (no shell, no
 *     package manager) plus `/stage/app`, the Bun binary and the spec's
 *     binaries, run as the base's non-root user;
 *   - CI builds the image and runs `verify <spec> <image>`: every file the
 *     image adds to its base must match the spec's allowlist, every required
 *     path must exist, no shell may exist anywhere, and the image must run as
 *     a non-root user.
 *
 * A spec is a TypeScript module default-exporting a {@link ServiceImageSpec}
 * (e.g. `apps/api-gateway/image.ts`). Self-contained (node builtins and Bun
 * only), so the Dockerfile can run it from the builder stage.
 *
 * Usage:
 *   bun scripts/service-image.ts stage  <spec.ts> <out-dir>
 *   bun scripts/service-image.ts verify <spec.ts> <image-ref>
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/** What one service image is made of. Paths are relative to the repo root unless noted. */
export interface ServiceImageSpec {
  /** The Dockerfile that builds the image; its last `FROM` is the runtime base. */
  readonly dockerfile: string;
  /** Where the app lives inside the image (absolute), e.g. `/app`. */
  readonly appRoot: string;
  readonly bundle: {
    /** Entry points to bundle. Each becomes `<outdir>/<basename>.js`. */
    readonly entrypoints: readonly string[];
    /** Output directory, relative to the app root. */
    readonly outdir: string;
    /** Packages left out of the bundle; they must be in {@link nodeModules}. */
    readonly external: readonly string[];
  };
  /**
   * Packages the service resolves from disk at run time (externals, and what
   * code loaded at run time imports). Their dependency closure is staged.
   */
  readonly runtimePackages: readonly string[];
  /**
   * The C library of the runtime base. Bun installs the native bindings of
   * both Linux libcs; an optional dependency whose `libc` field excludes this
   * one is not staged.
   */
  readonly libc: "glibc" | "musl";
  /**
   * The staged closure, exactly, as app-relative package directories
   * (`node_modules/zod`). Staging refuses a closure that differs, so a new
   * dependency reaches the image only by a reviewed edit of the spec. An
   * entry may be a glob, for a native binding named after the platform
   * (`node_modules/@oxc-parser/binding-linux-*-gnu`); it must match a package.
   */
  readonly nodeModules: readonly string[];
  /** Repo globs copied to the same relative path under the app root. Each must match. */
  readonly copy: readonly string[];
  /** Binaries the Dockerfile adds outside the app root. */
  readonly binaries: readonly ImageBinary[];
  /** Other image path globs (no leading slash) the Dockerfile adds outside the app root. */
  readonly extraFiles: readonly string[];
  /** Image path globs that must each match at least one file. */
  readonly require: readonly string[];
}

/** A binary the Dockerfile copies into the image. */
export interface ImageBinary {
  /** Image path, no leading slash. */
  readonly path: string;
  /**
   * Package URL with the exact version, listed in the bundle SBOM so the
   * scan matches the binary's advisories (`pkg:cargo/deno@2.9.8`). `null`
   * only for a binary no advisory database tracks; say so at the spec.
   */
  readonly purl: string | null;
}

/** Basenames that make an image a shell host. None may exist anywhere in a service image. */
export const FORBIDDEN_BASENAMES: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "dash",
  "ash",
  "zsh",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
  "fish",
  "busybox",
  "toybox",
  "curl",
  "wget",
  "apt",
  "apt-get",
  "dpkg",
  "apk",
  "perl",
  "python3",
]);

const WORKSPACE_FILES = ["package.json", "src/**/*.ts", "dist/**/*.js"];
const WORKSPACE_EXCLUDE = [/\.test\.ts$/, /(^|\/)__tests__\//, /\.d\.ts$/];

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** One package of the run-time closure. */
export interface ClosurePackage {
  readonly name: string;
  /** App-relative directory in the image, e.g. `node_modules/zod`. */
  readonly imageDir: string;
  /** Where its files are on disk (symlinks resolved). */
  readonly sourceDir: string;
  /** A workspace package (copied as sources), not an installed one. */
  readonly workspace: boolean;
}

/**
 * The run-time dependency closure of `roots`, resolved the way Node and Bun
 * resolve them in the hoisted install (bunfig `linker = "hoisted"`).
 * `dependencies` are followed; `optionalDependencies` only where installed
 * (the native binding of the build platform). Throws on a dependency that is
 * not installed, so a broken install fails the build, not the first request.
 */
export function runtimeClosure(
  repoRootPath: string,
  roots: readonly string[],
  libc: ServiceImageSpec["libc"],
): ClosurePackage[] {
  // Package directories are compared as real paths (workspace symlinks).
  const repoRoot = realpathSync(repoRootPath);
  const out = new Map<string, ClosurePackage>();
  const queue: Array<{ name: string; fromImageDir: string; fromSourceDir: string }> = roots.map(
    (name) => ({ name, fromImageDir: "", fromSourceDir: repoRoot }),
  );
  while (queue.length > 0) {
    const next = queue.shift() as (typeof queue)[number];
    const found = resolvePackage(repoRoot, next.name, next.fromImageDir, next.fromSourceDir);
    if (!found) {
      if (next.fromImageDir === "" && roots.includes(next.name)) {
        throw new Error(`runtime package ${next.name} is not installed under ${repoRoot}`);
      }
      throw new Error(
        `${next.name} (a dependency of ${next.fromImageDir || "the spec"}) is not installed`,
      );
    }
    if (out.has(found.imageDir)) continue;
    out.set(found.imageDir, found);
    const pkg = readJson(join(found.sourceDir, "package.json"));
    const deps = Object.keys((pkg.dependencies as Record<string, string> | undefined) ?? {});
    const optional = Object.keys(
      (pkg.optionalDependencies as Record<string, string> | undefined) ?? {},
    );
    for (const dep of deps) {
      queue.push({ name: dep, fromImageDir: found.imageDir, fromSourceDir: found.sourceDir });
    }
    for (const dep of optional) {
      const installed = resolvePackage(repoRoot, dep, found.imageDir, found.sourceDir);
      if (installed && supportsLibc(installed.sourceDir, libc)) {
        queue.push({ name: dep, fromImageDir: found.imageDir, fromSourceDir: found.sourceDir });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.imageDir.localeCompare(b.imageDir));
}

/** A package without a `libc` field runs on either. */
function supportsLibc(packageDir: string, libc: ServiceImageSpec["libc"]): boolean {
  const declared = readJson(join(packageDir, "package.json")).libc;
  return !Array.isArray(declared) || declared.includes(libc);
}

/**
 * Find `name` from a package the way the resolver does: the package's own
 * `node_modules`, then each parent's, up to the repo root. A package found
 * inside its importer is staged inside it; one found at the root is staged
 * at the app root. Anything in between (an intermediate workspace
 * `node_modules`) has no place in the image layout and is refused.
 */
function resolvePackage(
  repoRoot: string,
  name: string,
  fromImageDir: string,
  fromSourceDir: string,
): ClosurePackage | null {
  let dir = fromSourceDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) {
      let imageBase: string;
      if (dir === fromSourceDir && fromImageDir !== "") imageBase = fromImageDir;
      else if (dir === repoRoot) imageBase = "";
      else {
        throw new Error(
          `${name} resolves from ${toPosix(relative(repoRoot, candidate))}, which the image layout cannot reproduce; hoist it to the root node_modules`,
        );
      }
      const sourceDir = realpathSync(candidate);
      const insideNodeModules = toPosix(relative(repoRoot, sourceDir)).includes("node_modules/");
      return {
        name,
        imageDir: toPosix(join(imageBase, "node_modules", name)),
        sourceDir,
        workspace: !insideNodeModules,
      };
    }
    if (dir === repoRoot || dir === dirname(dir)) return null;
    dir = dirname(dir);
  }
}

/** The files of one closure package that the image carries, as paths relative to the package. */
export function packageFiles(pkg: ClosurePackage): string[] {
  const files = new Set<string>();
  if (pkg.workspace) {
    for (const pattern of WORKSPACE_FILES) {
      for (const f of new Bun.Glob(pattern).scanSync({ cwd: pkg.sourceDir, onlyFiles: true })) {
        const rel = toPosix(f);
        if (!WORKSPACE_EXCLUDE.some((re) => re.test(rel))) files.add(rel);
      }
    }
  } else {
    for (const f of new Bun.Glob("**/*").scanSync({
      cwd: pkg.sourceDir,
      onlyFiles: true,
      dot: true,
    })) {
      const rel = toPosix(f);
      // Nested installs are closure packages of their own.
      if (!rel.startsWith("node_modules/") && !rel.includes("/node_modules/")) files.add(rel);
    }
  }
  return [...files].sort();
}

/** Compare the computed closure with the spec's list; returns the problems. */
export function closureProblems(
  closure: readonly ClosurePackage[],
  expected: readonly string[],
): string[] {
  const actual = closure.map((p) => p.imageDir);
  const want = expected.map((pattern) => ({ pattern, glob: new Bun.Glob(pattern) }));
  const problems: string[] = [];
  for (const dir of actual) {
    if (!want.some((w) => w.glob.match(dir)))
      problems.push(`${dir} is in the run-time closure but not in the spec's nodeModules`);
  }
  for (const w of want) {
    if (!actual.some((dir) => w.glob.match(dir)))
      problems.push(`${w.pattern} is in the spec's nodeModules but not in the run-time closure`);
  }
  return problems;
}

/**
 * The bundle's SBOM, next to the bundle. A bundle hides the npm packages it
 * inlines from an image scanner, which finds packages by their
 * `package.json`; Trivy reads a CycloneDX file it finds in the image, so the
 * image scan (CI's gate, and any operator's own) still sees every one.
 */
export const BUNDLE_SBOM = "bundled-packages.cdx.json";

/**
 * The licence texts of the packages the bundle inlines, next to the bundle.
 * Unbundled, each package's LICENSE travelled with it in `node_modules`; the
 * bundle keeps their code, so it must keep their notices too (MIT/BSD/ISC/
 * Zlib all require the notice in copies).
 */
export const BUNDLE_LICENSES = "third-party-licenses.txt";

/** An npm package inlined into the bundle. */
export interface BundledPackage {
  readonly name: string;
  readonly version: string;
  /** Its install directory, relative to the repo root. */
  readonly dir: string;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$|^licen[cs]e-/i;

/**
 * The licence notice file for `packages`: each package's licence files
 * verbatim, under a `name@version (licence)` header. A package that ships no
 * licence file is refused (CLAUDE.md §2: no silent gaps) unless its
 * `package.json` names the licence — then the header says the package ships
 * no text.
 */
export function licenseNotice(repoRoot: string, packages: readonly BundledPackage[]): string {
  const parts = packages.map((p) => {
    const dir = join(repoRoot, p.dir);
    const license = readJson(join(dir, "package.json")).license;
    const files = readdirSync(dir)
      .filter((f) => LICENSE_FILE.test(f))
      .sort();
    const header = `${p.name}@${p.version} (${typeof license === "string" ? license : "licence in the text below"})`;
    if (files.length === 0) {
      if (typeof license !== "string")
        throw new Error(`${p.dir}: no licence file and no licence field`);
      return `${header}\n${"=".repeat(header.length)}\nThe package ships no licence text; package.json declares ${license}.\n`;
    }
    const texts = files.map((f) => readFileSync(join(dir, f), "utf8").trimEnd()).join("\n\n");
    return `${header}\n${"=".repeat(header.length)}\n${texts}\n`;
  });
  return `Third-party software inlined into this bundle, with its licence notices.\n\n${parts.join("\n\n")}`;
}

/**
 * The npm packages behind the bundler's input files (metafile paths,
 * relative to the repo root). Workspace sources are Caelo's own code and
 * carry no package version a scanner could match, so they are not listed.
 */
export function bundledPackages(repoRoot: string, inputs: readonly string[]): BundledPackage[] {
  const found = new Map<string, BundledPackage>();
  for (const input of inputs) {
    const posix = toPosix(input);
    const at = posix.lastIndexOf("node_modules/");
    if (at === -1) continue;
    const rest = posix.slice(at + "node_modules/".length).split("/");
    const nameParts = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
    const dir = `${posix.slice(0, at)}node_modules/${nameParts.join("/")}`;
    if (found.has(dir)) continue;
    const manifest = join(repoRoot, dir, "package.json");
    if (!existsSync(manifest)) throw new Error(`bundled input ${input} has no ${dir}/package.json`);
    const pkg = readJson(manifest);
    found.set(dir, { name: String(pkg.name), version: String(pkg.version), dir });
  }
  // One entry per name@version: the same release installed twice is one package.
  const unique = new Map([...found.values()].map((p) => [`${p.name}@${p.version}`, p]));
  return [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/**
 * A minimal CycloneDX 1.5 document: `packages` as npm libraries, and each
 * binary with a package URL as an application.
 */
export function cycloneDx(
  packages: readonly BundledPackage[],
  binaries: readonly ImageBinary[],
): Record<string, unknown> {
  const apps = binaries.flatMap((b) => {
    if (!b.purl) return [];
    const m = /^pkg:[a-z]+\/(.+)@([^@/]+)$/.exec(b.purl);
    if (!m) throw new Error(`${b.path}: purl ${b.purl} carries no version`);
    return [{ type: "application", name: m[1], version: m[2], purl: b.purl }];
  });
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    components: [
      ...packages.map((p) => ({
        type: "library",
        name: p.name,
        version: p.version,
        purl: `pkg:npm/${p.name.replace(/^@/, "%40")}@${p.version}`,
      })),
      ...apps,
    ],
  };
}

/** Load a spec module by path (default export). */
export async function loadSpec(path: string): Promise<ServiceImageSpec> {
  const mod = (await import(resolve(path))) as { default?: ServiceImageSpec };
  if (!mod.default) throw new Error(`${path} has no default export`);
  return mod.default;
}

/**
 * Stage the app tree: `<out>/<appRoot>/…` holds the bundle, the run-time
 * packages and the copied files, nothing else.
 */
export async function stage(
  repoRoot: string,
  spec: ServiceImageSpec,
  outDir: string,
): Promise<void> {
  const appDir = join(outDir, spec.appRoot);
  const outdir = join(appDir, spec.bundle.outdir);
  const closure = runtimeClosure(repoRoot, spec.runtimePackages, spec.libc);
  const problems = closureProblems(closure, spec.nodeModules);
  for (const ext of spec.bundle.external) {
    if (!closure.some((p) => p.name === ext))
      problems.push(`external ${ext} is not staged; add it to runtimePackages`);
  }
  if (problems.length > 0)
    throw new Error(`run-time closure mismatch:\n  - ${problems.join("\n  - ")}`);

  await bundleService(repoRoot, spec, outdir);

  for (const pkg of closure) {
    for (const rel of packageFiles(pkg)) {
      const dest = join(appDir, pkg.imageDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(pkg.sourceDir, rel), dest, { dereference: true });
    }
  }

  for (const pattern of spec.copy) {
    let matched = 0;
    for (const f of new Bun.Glob(pattern).scanSync({ cwd: repoRoot, onlyFiles: true, dot: true })) {
      const dest = join(appDir, f);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(repoRoot, f), dest, { dereference: true });
      matched++;
    }
    if (matched === 0) throw new Error(`copy pattern ${pattern} matched no file under ${repoRoot}`);
  }
}

/**
 * Bundle the spec's entry points into `outdir`, with the SBOM of what the
 * bundle inlines ({@link BUNDLE_SBOM}).
 */
export async function bundleService(
  repoRoot: string,
  spec: ServiceImageSpec,
  outdir: string,
): Promise<void> {
  mkdirSync(outdir, { recursive: true });
  const built = await Bun.build({
    entrypoints: spec.bundle.entrypoints.map((e) => join(repoRoot, e)),
    outdir,
    target: "bun",
    format: "esm",
    // Shared chunks: the entry points share almost all their code.
    splitting: true,
    external: [...spec.bundle.external],
    // Bun's bundler replaces `process.env.NODE_ENV` with "development" by
    // default and drops the branches it decides are dead — in the gateway
    // that removed the `Secure` cookie flag and turned on dev-key signing at
    // boot. The identity define keeps it a run-time read of the image's env.
    define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
    naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    metafile: true,
  });
  if (!built.success) {
    throw new Error(`bundle failed:\n${built.logs.map((l) => String(l)).join("\n")}`);
  }
  const inputs = Object.keys((built as { metafile?: { inputs: object } }).metafile?.inputs ?? {});
  if (inputs.length === 0) throw new Error("the bundler returned no metafile inputs");
  const packages = bundledPackages(repoRoot, inputs);
  writeFileSync(
    join(outdir, BUNDLE_SBOM),
    `${JSON.stringify(cycloneDx(packages, spec.binaries), null, 2)}\n`,
  );
  writeFileSync(join(outdir, BUNDLE_LICENSES), licenseNotice(repoRoot, packages));
}

/** The allowlist of image paths (no leading slash) a spec permits beyond the base image. */
export function allowedPatterns(spec: ServiceImageSpec): string[] {
  const app = spec.appRoot.replace(/^\/+|\/+$/g, "");
  return [
    ...spec.binaries.map((b) => b.path),
    ...spec.extraFiles,
    `${app}/${spec.bundle.outdir}/*`,
    ...spec.nodeModules.map((dir) => `${app}/${dir}/**`),
    ...spec.copy.map((pattern) => `${app}/${pattern}`),
  ];
}

/** One problem found in an image, worded for the CI log. */
export type ContentProblem = string;

/**
 * Check an image's files against its spec.
 *
 * @param args.files Every non-directory path of the flattened image.
 * @param args.baseFiles The same for the runtime base.
 * @param args.added Every non-directory entry of the layers the image adds on
 *   top of its base, whiteouts included: what the Dockerfile wrote. Checking
 *   these, not just the paths missing from the base, is what catches a build
 *   that overwrites or deletes a base file (`etc/passwd`).
 */
export function contentProblems(args: {
  readonly spec: ServiceImageSpec;
  readonly files: readonly string[];
  readonly baseFiles: readonly string[];
  readonly added: readonly string[];
}): ContentProblem[] {
  const problems: ContentProblem[] = [];
  const base = new Set(args.baseFiles);
  const allow = allowedPatterns(args.spec).map((p) => new Bun.Glob(p));
  for (const file of args.files) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (FORBIDDEN_BASENAMES.has(name))
      problems.push(`${file}: no shell or tool of this kind may be in the image`);
  }
  for (const entry of new Set(args.added)) {
    const name = entry.slice(entry.lastIndexOf("/") + 1);
    if (name.startsWith(".wh.")) {
      problems.push(`${entry}: the image deletes a file of its base`);
    } else if (base.has(entry)) {
      problems.push(`${entry}: the image replaces a file of its base`);
    } else if (!allow.some((g) => g.match(entry))) {
      problems.push(`${entry}: not in the allowlist`);
    }
  }
  for (const pattern of args.spec.require) {
    const glob = new Bun.Glob(pattern);
    if (!args.files.some((f) => glob.match(f))) problems.push(`${pattern}: required, but missing`);
  }
  return problems;
}

/** The parts of `docker image inspect .Config` the check reads. */
export interface ImageConfig {
  readonly User?: string;
  readonly Entrypoint?: readonly string[] | null;
  readonly Cmd?: readonly string[] | null;
}

/** The image must run as a fixed non-root user; a user name could map to uid 0. */
export function configProblems(config: ImageConfig): ContentProblem[] {
  const problems: ContentProblem[] = [];
  const user = (config.User ?? "").split(":")[0] ?? "";
  if (!/^[1-9][0-9]*$/.test(user)) {
    problems.push(
      `runs as user ${JSON.stringify(config.User ?? "")}: set USER to a numeric non-root uid`,
    );
  }
  if (!config.Entrypoint || config.Entrypoint.length === 0) {
    problems.push("has no exec-form ENTRYPOINT");
  }
  return problems;
}

/**
 * The runtime base of a Dockerfile: the image of its last `FROM`. Every
 * `FROM` must be pinned by digest: a builder stage on a moving tag puts
 * whatever it copies into the image just as much as the base does.
 */
export function runtimeBase(dockerfile: string): string {
  const froms = [...dockerfile.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].map(
    (m) => m[1] as string,
  );
  const last = froms.at(-1);
  if (!last) throw new Error("the Dockerfile has no FROM");
  const unpinned = froms.filter((ref) => !/@sha256:[0-9a-f]{64}$/.test(ref));
  if (unpinned.length > 0) throw new Error(`not pinned by digest: ${unpinned.join(", ")}`);
  return last;
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}: ${err.trim()}`);
  return out;
}

/** Non-directory entries of a tar stream (no leading `./` or `/`). */
async function tarEntries(stream: ReadableStream<Uint8Array>, what: string): Promise<string[]> {
  const tar = Bun.spawn(["tar", "-t"], { stdin: stream, stdout: "pipe", stderr: "pipe" });
  const [listing, err, code] = await Promise.all([
    new Response(tar.stdout).text(),
    new Response(tar.stderr).text(),
    tar.exited,
  ]);
  if (code !== 0) throw new Error(`listing ${what} failed: ${err.trim()}`);
  return listing
    .split("\n")
    .filter((l) => l !== "" && !l.endsWith("/"))
    .map((l) => l.replace(/^\.?\//, ""));
}

/** Non-directory entries of an image's flattened filesystem. */
async function imageFiles(image: string): Promise<string[]> {
  // `docker create` never starts the container; the command only satisfies
  // images without a default one (a distroless base).
  const id = (await run(["docker", "create", image, "/service-image-listing"])).trim();
  try {
    const exported = Bun.spawn(["docker", "export", id], { stdout: "pipe", stderr: "pipe" });
    const [entries, code] = await Promise.all([
      tarEntries(exported.stdout, `${image} (docker export)`),
      exported.exited,
    ]);
    if (code !== 0) throw new Error(`docker export of ${image} exited ${code}`);
    return entries;
  } finally {
    await run(["docker", "rm", id]);
  }
}

async function rootfsLayers(image: string): Promise<string[]> {
  return JSON.parse(
    await run(["docker", "image", "inspect", "--format", "{{json .RootFS.Layers}}", image]),
  ) as string[];
}

/**
 * Entries of the layers `image` adds on top of `base`, whiteouts included.
 * Refuses an image whose first layers are not exactly the base's.
 */
async function addedLayerEntries(image: string, base: string): Promise<string[]> {
  const [layers, baseLayers] = await Promise.all([rootfsLayers(image), rootfsLayers(base)]);
  if (baseLayers.some((l, i) => layers[i] !== l)) {
    throw new Error(`${image} is not built on ${base}: its first layers differ`);
  }
  const dir = mkdtempSync(join(tmpdir(), "service-image-layers-"));
  try {
    const saved = join(dir, "image.tar");
    await run(["docker", "save", "--output", saved, image]);
    await run(["tar", "-xf", saved, "-C", dir]);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Array<{
      Layers: string[];
    }>;
    const paths = manifest[0]?.Layers ?? [];
    if (paths.length !== layers.length) {
      throw new Error(
        `docker save of ${image} lists ${paths.length} layers, docker inspect ${layers.length}`,
      );
    }
    const entries: string[] = [];
    for (const layer of paths.slice(baseLayers.length)) {
      entries.push(...(await tarEntries(Bun.file(join(dir, layer)).stream(), `layer ${layer}`)));
    }
    return entries;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function verify(
  repoRoot: string,
  spec: ServiceImageSpec,
  image: string,
): Promise<ContentProblem[]> {
  const base = runtimeBase(readFileSync(join(repoRoot, spec.dockerfile), "utf8"));
  await run(["docker", "pull", "--quiet", base]);
  const [files, baseFiles, added, inspect] = await Promise.all([
    imageFiles(image),
    imageFiles(base),
    addedLayerEntries(image, base),
    run(["docker", "image", "inspect", "--format", "{{json .Config}}", image]),
  ]);
  return [
    ...configProblems(JSON.parse(inspect) as ImageConfig),
    ...contentProblems({ spec, files, baseFiles, added }),
  ];
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, specPath, target] = argv;
  if ((command !== "stage" && command !== "verify") || !specPath || !target) {
    console.error("usage: service-image.ts stage <spec.ts> <out-dir> | verify <spec.ts> <image>");
    return 64;
  }
  const repoRoot = resolve(import.meta.dir, "..");
  const spec = await loadSpec(specPath);
  if (command === "stage") {
    await stage(repoRoot, spec, resolve(target));
    console.log(`[service-image] staged ${specPath} into ${target}`);
    return 0;
  }
  const problems = await verify(repoRoot, spec, target);
  for (const p of problems) console.error(`[service-image] ${target}: ${p}`);
  if (problems.length > 0) return 1;
  console.log(`[service-image] ${target}: non-root, no shell, every file allowlisted`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
