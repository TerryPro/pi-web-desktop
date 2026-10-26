<#
.SYNOPSIS
    Packs Pi Web into resources/pi-web, the tree this shell ships, and prints the
    next step (cargo or the Tauri installer).

.DESCRIPTION
    A wrapper over package.mjs, which holds the steps and the reasons behind
    them. Keep the work there. This file stays so the command lives beside the
    shell it builds: `.pi-web` defaults to a sibling checkout, and
    `scripts/package.mjs` refuses to copy a `.next` that was built elsewhere.

.PARAMETER SkipBuild
    Reuse the existing .next instead of running `next build`.

.PARAMETER Check
    Upgrade check only: the local edit pi-web needs, the shell version, and the
    pinned pi packages. Nothing is built or copied.

.PARAMETER Fix
    Write pi-web's version into Cargo.toml and tauri.conf.json when they differ.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1 -Check
    powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1 -Check -Fix
    powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
    powershell -ExecutionPolicy Bypass -File scripts\build-desktop.ps1 -SkipBuild
#>
param(
    [switch]$SkipBuild,
    [switch]$Check,
    [switch]$Fix
)

$ErrorActionPreference = 'Stop'

$packager = Join-Path $PSScriptRoot 'package.mjs'
if (-not (Test-Path $packager)) {
    throw "Packaging script not found at $packager"
}

$packagerArgs = @()
if ($SkipBuild) { $packagerArgs += '--skip-build' }
if ($Check) { $packagerArgs += '--check' }
if ($Fix) { $packagerArgs += '--fix' }

& node $packager @packagerArgs
exit $LASTEXITCODE
