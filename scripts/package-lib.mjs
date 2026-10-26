// Pure helpers behind scripts/package.mjs. Kept apart so they can be tested
// without touching a checkout, a build output, or the shell's config files.
//
// The version patterns stop before `\r`/`\n` so a CRLF file parses and a rewrite
// leaves the line ending alone.

/** Version from the first `version = "..."` line, which is `[package]`'s. */
export function parseCargoVersion(text) {
  return /^version = "([^"\r\n]*)"/m.exec(text)?.[1] ?? null;
}

/** Rewrites only that first line; dependency versions stay as they are. */
export function withCargoVersion(text, version) {
  return text.replace(/^version = "[^"\r\n]*"/m, `version = "${version}"`);
}

/** Top-level version of tauri.conf.json, by pattern: the file must keep its layout. */
export function parseTauriVersion(text) {
  return /"version":\s*"([^"\r\n]*)"/.exec(text)?.[1] ?? null;
}

export function withTauriVersion(text, version) {
  return text.replace(/"version":\s*"[^"\r\n]*"/, `"version": "${version}"`);
}

/**
 * Paths out of `git status --porcelain`. Each line starts with two status
 * columns and a space: " M next.config.ts", "?? scripts/new.mjs". Trimming the
 * whole output first eats the first line's leading space and cuts a character
 * off that path.
 */
export function porcelainPaths(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.slice(3).trim());
}
