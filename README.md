# Pi Web Desktop

Desktop shell for [Pi Web](https://github.com/agegr/pi-web), the local web UI for the
[pi coding agent](https://github.com/earendil-works/pi).

English | [中文](./README.zh-CN.md)

This repository contains only the shell. The web application itself is upstream
`pi-web`, and a new pi-web release is pulled in without patching it: the shell
ships a build of that checkout as its resources and serves it from a local port.

## How it works

1. The Tauri app starts.
2. It finds the bundled Node runtime and the packaged Pi Web tree under
   `resources/`.
3. It picks a free loopback port and runs `node start.js` in that tree.
4. It waits for the server to answer, then navigates the window to
   `http://127.0.0.1:<port>`.
5. On exit it kills the server process tree. A Windows job object covers the case
   where the shell dies without running its exit handler.

The server binds `127.0.0.1` only. Nothing is exposed to the network.

## Relationship with pi-web

`pi-web` is maintained upstream and is not modified here beyond one line. Everything
that makes it a desktop app lives in this repository.

The one local edit, in `pi-web/next.config.ts`:

```ts
output: process.env.PI_WEB_DESKTOP_BUILD ? "standalone" : undefined,
```

The packaging script sets `PI_WEB_DESKTOP_BUILD=1` while building, so
`next build` produces `.next/standalone`. A normal `npm run build` in the pi-web
checkout still behaves exactly like upstream, which matters because
`bin/pi-web.js` starts the server with `next start`, and Next refuses a
standalone build there.

`scripts/package.mjs` checks that this line is still present before it builds.
If an upstream release rewrites that config, the check fails with the expected
line instead of producing a tree the shell cannot serve.

## Requirements

| What | Version | Why |
| --- | --- | --- |
| Windows | 10 or 11 | The installer targets NSIS; process cleanup uses a Win32 job object |
| Node.js | 22.19.0 or newer | pi-web's own minimum, checked again at runtime by `packaging/start.js` |
| Rust | 1.77.2 or newer | `rust-version` in `Cargo.toml` |
| Pi Web checkout | any version the checks accept | Expected at `../pi-web` |

Untested on macOS and Linux. The Rust side has fallbacks for both, but the
installer target and the job object are Windows-only.

## Build

### 1. Check out both repositories side by side

```
some-folder/
├── pi-web/            git clone https://github.com/agegr/pi-web.git
└── pi-web-desktop/    this repository
```

### 2. Prepare pi-web

```powershell
cd ..\pi-web
npm install
```

Then add the standalone switch to `next.config.ts`:

```ts
output: process.env.PI_WEB_DESKTOP_BUILD ? "standalone" : undefined,
```

### 3. Package

```powershell
cd ..\pi-web-desktop
powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
```

This runs `next build` in `../pi-web` with the standalone switch, then copies the
result into `resources/pi-web`. It takes a few minutes and rewrites the whole
`resources/` tree.

Close a running Pi Web before packaging. The script replaces the tree and fails
with a clear message if a process holds it.

### 4. Build the shell

```powershell
cargo build --release
```

Or build the installer:

```powershell
npx --yes @tauri-apps/cli@2 build
```

`cargo build --release` alone gives `target/release/pi-web-desktop.exe` plus the
`resources/` it expects next to it. The installer path produces an NSIS setup
package.

## Scripts

`scripts/build-desktop.ps1` is a wrapper over `scripts/package.mjs`. Use the
PowerShell file for the flags; use the `.mjs` directly when you want the same
behavior from another shell.

| Flag | Effect |
| --- | --- |
| none | Checks, builds, packages, slims |
| `-SkipBuild` (`--skip-build`) | Reuse the existing `.next` instead of building |
| `-Check` (`--check`) | Run the checks only, build nothing |
| `-Fix` (`--fix`) | Write pi-web's version into `Cargo.toml` and `tauri.conf.json` |

The first step is an upgrade check. It reports and fails before anything is built:

| Check | Failure |
| --- | --- |
| `next.config.ts` still keys `output` off `PI_WEB_DESKTOP_BUILD` | Stops, prints the expected line |
| pi-web has no local changes besides `next.config.ts` | Warns and lists the extra files |
| `Cargo.toml` and `tauri.conf.json` carry pi-web's version | Stops; `-Fix` writes them |
| `@earendil-works/*` are pinned exactly and installed | Stops with the mismatched packages |

The last step removes what the running server never reads: source directories,
build caches, docs, build-time configs and `package-lock.json`.

## Runtime files

| Path | Contents |
| --- | --- |
| `%TEMP%\pi-web-desktop.log` | Startup trace. Truncated at the start of a run once it passes 1 MB |
| `~/.pi/agent/` | Sessions and settings, shared with the pi CLI and Pi Web |
| `resources/pi-web` | Generated. Ignored by git |

## Tests

```powershell
node --test "scripts/*.test.mjs"
```

Covers the pure parts of the packaging script: reading and rewriting the version
in `Cargo.toml` and `tauri.conf.json`, and parsing `git status --porcelain`.
Passing a directory to `node --test` does not work on Node 24; use the glob.

There is no CI for this repository yet.

## Repository layout

```
src/main.rs              window, sidecar lifecycle, ready probe, log
packaging/start.js       desktop entry inside the packaged tree
scripts/package.mjs      the packaging pipeline
scripts/package-lib.mjs  its pure helpers
scripts/build-desktop.ps1  flag wrapper
loading/index.html       what the window shows until the server answers
resources/               generated by the packaging script, not in git
```

## Troubleshooting

**The first launch after a build or install takes 30 to 60 seconds.**

Healthy. The packaging step writes thousands of files, the bundled pi SDK alone
is about 2,000 of them, and the server imports that SDK during startup. On
Windows this competes with real-time file scanning. Later launches take about a
second. Excluding the install directory from Defender's real-time scanning is the
only way to remove the wait; the code cannot.

**`ERROR: cannot clear ...\resources\pi-web (EPERM)`**

A Pi Web process is running from that tree. Close it and run the script again.

**`EBUSY: resource busy or locked, rmdir '...\.next\standalone'`**

A server is still running from the pi-web checkout, usually a `next start` left
over from testing. Stop it and build again.

**`ERROR: .next\node_modules points at a checkout that no longer exists`**

The `.next` in the pi-web folder was built from another path, so its junctions
dangle. Run the packaging script without `-SkipBuild`.

**`ERROR: version mismatch - rerun with --fix`**

pi-web and the shell carry different versions. `-Fix` copies pi-web's version into
`Cargo.toml` and `tauri.conf.json`.

**The window shows "Pi Web could not be started" with an exit code**

The server exited before it answered. The message names the exit code and points
at `%TEMP%\pi-web-desktop.log`, which holds the server's own output.

## Not included

These are known gaps, not bugs to report:

- No automatic updates. A new release means a new installer.
- No single-instance lock. Two windows start two servers, and two servers writing
  the same session file is untested.
- No tray icon, no start at login, no window position memory.
- The bundled pi-web still checks npm for a newer `@agegr/pi-web` and will report
  one. The shell cannot install it; that update belongs to a new installer.
