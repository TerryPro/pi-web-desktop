#!/usr/bin/env node
/**
 * Packs a Pi Web build into resources/pi-web, the tree the Tauri shell ships.
 * `scripts/build-desktop.ps1` beside this file only passes the flags through.
 * The Pi Web checkout defaults to a sibling directory (../pi-web).
 *
 * Step 1 is the upgrade check: whether pi-web still carries the local edit that
 * turns on standalone output, whether the shell's version matches pi-web, and
 * whether node_modules matches the pinned pi packages. It runs before anything
 * is built; `--check` stops there and `--fix` writes the version through.
 *
 * Next's `output: "standalone"` cannot be used as desktop resources as-is.
 * Each of these was learned the hard way; do not drop any of them:
 *
 *   1. Turbopack traces the whole project when it meets a runtime-only path (for
 *      example lib/worktree.ts resolving a repo root), so `standalone/.git` lands
 *      in the output. The Tauri shell living beside pi-web (not inside it) is
 *      what keeps its Rust target directory out.
 *   2. `serverExternalPackages` are emitted as *junctions* under
 *      `.next/standalone/.next/node_modules`, pointing at the full build. They
 *      must be copied with their targets or the server dies at startup with
 *      `Cannot find module 'undici-<hash>'`. They also break when the checkout
 *      moves, so the copy is refused while any of them dangles.
 *   3. Next does not copy `.next/static` into the standalone folder; without it
 *      every `/_next/static/*` request 404s and the page stays blank.
 *   4. pi-web's preview-secret rotation lives in the CLI (bin/pi-web.js), which a
 *      standalone `server.js` start never runs, so packaging/start.js does it.
 *   5. git's pack files are read-only, so removing a copied `.git` fails until
 *      the attribute is cleared.
 *   6. The source copies inside `standalone/` are dead weight: the runtime only
 *      reads `standalone/`.
 *
 * Usage: node scripts/package.mjs [--skip-build] [--check] [--fix]
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCargoVersion,
  parseTauriVersion,
  porcelainPaths,
  withCargoVersion,
  withTauriVersion,
} from "./package-lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.dirname(scriptDir);
const piWebDir = path.resolve(desktopDir, "..", "pi-web");
const nextDir = path.join(piWebDir, ".next");
const standaloneDir = path.join(nextDir, "standalone");
const destDir = path.join(desktopDir, "resources", "pi-web");
const startEntry = path.join(desktopDir, "packaging", "start.js");
const bundledNode = path.join(desktopDir, "resources", "node", "node.exe");

// Directories holding the project's sources. The running server reads none of
// them; `.next/server` and `.next/static` stay, because bin/pi-web.js starts a
// published tree with `next start` and npm publishes `.next`.
const SOURCE_DIRS = ["app", "components", "demo", "docs", "e2e", "hooks", "lib", "scripts"];

// Root files the running server never reads: docs, build-time configs and the
// package manager's bookkeeping. Next embeds its config in server.js.
const SPARE_FILES = [
  "AGENTS.md",
  "CONTEXT.md",
  "CONTRIBUTING.md",
  "README.md",
  "eslint.config.mjs",
  "postcss.config.mjs",
  "tailwind.config.ts",
  "tsconfig.json",
  "tsconfig.tsbuildinfo",
  "package-lock.json",
];

const argv = process.argv.slice(2);
const skipBuild = argv.includes("--skip-build");
const checkOnly = argv.includes("--check");
const fixVersions = argv.includes("--fix");
const stepTotal = 8;
let stepIndex = 0;

function step(title) {
  stepIndex += 1;
  console.log(`[${stepIndex}/${stepTotal}] ${title}`);
}

function note(message) {
  console.log(`      ${message}`);
}

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

// The one local edit pi-web keeps: standalone output, but only for this build.
// Losing it means `next build` produces no .next/standalone at all.
const EXPECTED_LOCAL_EDITS = ["next.config.ts"];
const OUTPUT_MARKER = "PI_WEB_DESKTOP_BUILD";

// Raw stdout: porcelain lines start with a status column that trimming the whole
// output would eat on the first line.
function git(args) {
  const result = spawnSync("git", args, { cwd: piWebDir, encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function checkUpgrade() {
  checkLocalEdits();
  checkVersions();
  checkPiPackages();
}

function checkLocalEdits() {
  const configPath = path.join(piWebDir, "next.config.ts");
  if (!fs.readFileSync(configPath, "utf8").includes(OUTPUT_MARKER)) {
    fail(
      `next.config.ts no longer keys output off ${OUTPUT_MARKER}.\n` +
        `  Expected: output: process.env.${OUTPUT_MARKER} ? "standalone" : undefined,`,
    );
  }

  const version = readJson(path.join(piWebDir, "package.json")).version;
  const status = git(["status", "--porcelain"]);
  if (status === null) {
    note(`pi-web ${version} (not a git checkout, drift not checked)`);
    return;
  }

  const dirty = porcelainPaths(status);
  const unexpected = dirty.filter((file) => !EXPECTED_LOCAL_EDITS.includes(file));
  if (unexpected.length > 0) {
    note(`WARN pi-web has local changes beyond the desktop edit: ${unexpected.join(", ")}`);
  }

  const commit = git(["log", "-1", "--format=%h %ad", "--date=short"])?.trim() ?? "unknown";
  const behind = git(["rev-list", "--count", "HEAD..origin/main"])?.trim() ?? "0";
  const drift = behind && behind !== "0" ? ` - ${behind} commits behind origin/main as of the last fetch` : "";
  note(`pi-web ${version} at ${commit}${drift}`);
}

// The installer version has to follow the pi-web it carries; nothing else bumps
// Cargo.toml and tauri.conf.json when a new upstream release is pulled in.
function checkVersions() {
  const wanted = readJson(path.join(piWebDir, "package.json")).version;
  const files = [
    { file: "Cargo.toml", read: parseCargoVersion, write: withCargoVersion },
    { file: "tauri.conf.json", read: parseTauriVersion, write: withTauriVersion },
  ];

  const stale = [];
  for (const entry of files) {
    const filePath = path.join(desktopDir, entry.file);
    const text = fs.readFileSync(filePath, "utf8");
    const found = entry.read(text);
    if (found === wanted) continue;
    stale.push({ ...entry, filePath, text, found: found ?? "no version line" });
  }

  if (stale.length === 0) {
    note(`shell version ${wanted} matches pi-web`);
    return;
  }
  for (const entry of stale) {
    note(`${entry.file} has ${entry.found}, pi-web is ${wanted}`);
  }
  if (!fixVersions) {
    fail(`version mismatch - rerun with --fix to write ${wanted} into the shell.`);
  }
  for (const entry of stale) {
    fs.writeFileSync(entry.filePath, entry.write(entry.text, wanted));
    note(`wrote ${wanted} into ${entry.file}`);
  }
}

// pi's packages depend on each other with `^` ranges, so a range here pairs
// releases that were never tested together (AGENTS.md, lib/pi-packages.test.mjs).
function checkPiPackages() {
  const declared = Object.entries(readJson(path.join(piWebDir, "package.json")).dependencies ?? {})
    .filter(([name]) => name.startsWith("@earendil-works/"));
  if (declared.length === 0) {
    fail("package.json lists no @earendil-works packages; the checkout looks wrong.");
  }

  const ranged = declared.filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version));
  if (ranged.length > 0) {
    fail(
      "these pi packages are not pinned to an exact version:\n  " +
        ranged.map(([name, version]) => `${name}@${version}`).join("\n  "),
    );
  }

  const mismatch = [];
  for (const [name, version] of declared) {
    const installedPath = path.join(piWebDir, "node_modules", name, "package.json");
    if (!fs.existsSync(installedPath)) {
      mismatch.push(`${name}: not installed`);
      continue;
    }
    const installed = readJson(installedPath).version;
    if (installed !== version) mismatch.push(`${name}: package.json ${version}, node_modules ${installed}`);
  }
  if (mismatch.length > 0) {
    fail(`node_modules does not match package.json - run npm install in ${piWebDir}:\n  ${mismatch.join("\n  ")}`);
  }
  note(`${declared.length} pi packages pinned and installed`);
}

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  clearReadOnly(target);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// Windows keeps git's pack files read-only; rm fails with EPERM until cleared.
function clearReadOnly(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    if (!stat.isSymbolicLink() && (stat.mode & 0o200) === 0) fs.chmodSync(target, 0o666);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    clearReadOnly(path.join(target, entry.name));
  }
}

// dereference follows the junctions Next emits for serverExternalPackages.
function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: true, force: true });
}

function treeInfo(target) {
  if (!fs.existsSync(target)) return "absent";
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      files += 1;
      bytes += fs.statSync(full).size;
    }
  };
  walk(target);
  return `${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function danglingLinks(dir) {
  if (!fs.existsSync(dir)) return [];
  const broken = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (!fs.existsSync(full)) {
        broken.push(full);
      }
      continue;
    }
    if (entry.isDirectory()) broken.push(...danglingLinks(full));
  }
  return broken;
}

async function runNextBuild() {
  const nextBin = path.join(piWebDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "build"], {
    cwd: piWebDir,
    stdio: "inherit",
    // Standalone output only exists when this is set (see pi-web's next.config.ts).
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192", PI_WEB_DESKTOP_BUILD: "1" },
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) fail(`next build exited with code ${code}`);
}

// A build made in another checkout leaves junctions pointing at paths that no
// longer exist; copying those with dereference would abort half way.
function checkBuildIsUsable() {
  if (!fs.existsSync(path.join(standaloneDir, "server.js"))) {
    fail(".next/standalone/server.js is missing - run without --skip-build first.");
  }
  if (!fs.existsSync(startEntry)) {
    fail(`packaging/start.js is missing at ${startEntry}.`);
  }
  for (const dir of [path.join(nextDir, "node_modules"), path.join(standaloneDir, ".next", "node_modules")]) {
    const broken = danglingLinks(dir);
    if (broken.length === 0) continue;
    fail(
      `${path.relative(piWebDir, dir)} points at a checkout that no longer exists:\n` +
        `  ${broken[0]}\n` +
        "The .next in this folder was built somewhere else. Run without --skip-build.",
    );
  }
}

async function main() {
  if (!fs.existsSync(piWebDir)) {
    fail(`Pi Web checkout not found at ${piWebDir}.`);
  }

  step("checking the pi-web checkout");
  checkUpgrade();
  if (checkOnly) {
    console.log("\ncheck only: nothing was built or copied.");
    return;
  }

  if (skipBuild) {
    step("build skipped (--skip-build)");
  } else {
    step("next build (Turbopack, 8 GB heap)");
    await runNextBuild();
  }

  checkBuildIsUsable();

  step("dropping traced project directories from standalone");
  // `.git` sits inside the project root, so tracing keeps sweeping it in.
  const tracedGit = path.join(standaloneDir, ".git");
  if (fs.existsSync(tracedGit)) {
    removeTree(tracedGit);
    note("removed .git");
  }

  step("copying serverExternalPackages into standalone");
  const externals = path.join(nextDir, "node_modules");
  if (!fs.existsSync(externals)) {
    fail(".next/node_modules is missing; a Turbopack build should emit it.");
  }
  // The standalone copy holds junctions to these very packages, so clear it
  // first: writing through a junction would fill an empty directory elsewhere.
  const nested = path.join(standaloneDir, ".next", "node_modules");
  removeTree(nested);
  copyTree(externals, nested);

  step("copying .next/static into standalone");
  const staticDir = path.join(nextDir, "static");
  if (fs.existsSync(staticDir)) {
    copyTree(staticDir, path.join(standaloneDir, ".next", "static"));
  } else {
    note("skipped: no top-level .next/static (already inside standalone)");
  }

  step("writing the desktop entry (start.js)");
  fs.copyFileSync(startEntry, path.join(standaloneDir, "start.js"));

  step("syncing standalone into resources/pi-web");
  try {
    removeTree(destDir);
  } catch (error) {
    fail(
      `cannot clear ${destDir} (${error.code || error.message}). ` +
        "Close the running Pi Web app and try again; a stale tree cannot be replaced.",
    );
  }
  copyTree(standaloneDir, destDir);

  step("slimming: dropping caches, source copies and unread files");
  removeTree(path.join(nextDir, "cache"));
  for (const dir of SOURCE_DIRS) {
    removeTree(path.join(standaloneDir, dir));
    removeTree(path.join(destDir, dir));
  }
  for (const file of SPARE_FILES) {
    removeTree(path.join(standaloneDir, file));
    removeTree(path.join(destDir, file));
  }

  console.log("");
  console.log(`resources : ${treeInfo(destDir)}`);
  console.log(`.next     : ${treeInfo(nextDir)}`);
  console.log(`node.exe  : ${fs.existsSync(bundledNode) ? "present" : "MISSING (the shell will look for node on PATH)"}`);
  console.log("");
  console.log(`Next: ${desktopDir}`);
  console.log("      cargo build --release, or npx --yes @tauri-apps/cli@2 build");
}

await main();
