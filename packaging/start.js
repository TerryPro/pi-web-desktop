// Desktop entry, copied into the packaged tree by scripts/package.mjs.
//
// The shell runs `node start.js` with PORT and HOSTNAME set instead of the
// pi-web CLI: the desktop tree starts the standalone server directly, and the
// CLI would open a browser of its own.
"use strict";

const path = require("node:path");
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./bin/node-version");
const { getRotationWarning, rotatePreviewSecrets } = require("./bin/rotate-preview-secrets");

// bin/pi-web.js refuses an old Node before anything else. Without this check the
// shell only reports that the server never answered.
if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// Nothing else rotates the previewModeId Next baked into the build: the CLI
// (`next start`) does not run in this tree.
const rotation = rotatePreviewSecrets(path.join(__dirname, ".next"));
if (!rotation.ok) console.warn(getRotationWarning(rotation.reason));

// Orphan cleanup is the shell's job: the Rust side puts this process into a
// Windows job object with KILL_ON_JOB_CLOSE, so the kernel ends it whenever the
// shell goes away - including a Task Manager "End task", where no shell code
// gets to run.

require("./server.js");
