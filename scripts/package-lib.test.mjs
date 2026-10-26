import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCargoVersion,
  parseTauriVersion,
  porcelainPaths,
  withCargoVersion,
  withTauriVersion,
} from "./package-lib.mjs";

const CARGO = [
  "[package]",
  'name = "pi-web-desktop"',
  'version = "0.12.2"',
  'description = "Desktop shell for Pi Web"',
  "",
  "[dependencies]",
  'tauri = { version = "2", features = [] }',
  'windows-sys = { version = "0.59", features = ["Win32_Foundation"] }',
  "",
].join("\n");

const TAURI = [
  "{",
  '  "$schema": "https://schema.tauri.app/config/2",',
  '  "productName": "Pi Web",',
  '  "version": "0.12.2",',
  '  "identifier": "ai.pi.web.desktop",',
  '  "bundle": { "windows": { "nsis": { "installMode": "currentUser" } } }',
  "}",
  "",
].join("\n");

test("cargo: reads [package]'s version", () => {
  assert.equal(parseCargoVersion(CARGO), "0.12.2");
});

test("cargo: a file without a version line reports null", () => {
  assert.equal(parseCargoVersion('[package]\nname = "x"\n'), null);
});

test("cargo: a CRLF line parses without the carriage return", () => {
  assert.equal(parseCargoVersion('[package]\r\nversion = "1.2.3"\r\n'), "1.2.3");
});

test("cargo: rewriting keeps dependency versions and the line ending", () => {
  const updated = withCargoVersion(CARGO, "0.13.0");
  assert.equal(parseCargoVersion(updated), "0.13.0");
  assert.match(updated, /^tauri = \{ version = "2", features = \[\] \}$/m);
  assert.match(updated, /^windows-sys = \{ version = "0\.59"/m);

  const crlf = withCargoVersion('[package]\r\nversion = "1.2.3"\r\n', "2.0.0");
  assert.equal(crlf, '[package]\r\nversion = "2.0.0"\r\n');
});

test("tauri: reads and rewrites the top-level version", () => {
  assert.equal(parseTauriVersion(TAURI), "0.12.2");
  const updated = withTauriVersion(TAURI, "1.0.0");
  assert.equal(parseTauriVersion(updated), "1.0.0");
  assert.equal(JSON.parse(updated).version, "1.0.0");
  assert.equal(JSON.parse(updated).bundle.windows.nsis.installMode, "currentUser");
});

test("porcelain: keeps the first line's leading status column", () => {
  assert.deepEqual(porcelainPaths(" M next.config.ts\n"), ["next.config.ts"]);
  assert.deepEqual(porcelainPaths(" M next.config.ts\n?? scripts/new.mjs\n"), [
    "next.config.ts",
    "scripts/new.mjs",
  ]);
  assert.deepEqual(porcelainPaths(""), []);
  assert.deepEqual(porcelainPaths("\n\n"), []);
});
