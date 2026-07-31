#!/usr/bin/env node
"use strict";
/**
 * Extension sync audit — the committed runtime artifacts in extension/ must
 * match their canonical sources, so `Load unpacked → extension/` ships exactly
 * what `node build.js` would: the generated engine bundle (blocklist.js), the
 * blocklists, the recipe catalog, and the changelog.
 *
 * These files are generated/copied by `npm run sync` (tools/sync-extension.js).
 * This audit fails if any is missing or stale — with the one-line fix — so a
 * data or engine edit that forgets the resync can't ship a source folder that
 * silently loads yesterday's data. Runs in validate-all (build gate) and, via
 * test/extension-synced.test.js, in `npm test`.
 */

const { Reporter, runCli } = require("./lib/report");
const sync = require("./sync-extension");

function syncAudit() {
  const reporter = new Reporter("Extension sync (loadable source)");
  const stale = sync.staleArtifacts();
  const total = sync.expectedArtifacts().length;

  reporter.check(
    stale.length === 0,
    `extension/ is out of sync with canonical sources — run \`npm run sync\`: ${stale.join(", ")}`
  );

  if (stale.length === 0) {
    reporter.note(
      `${total} committed artifact(s) match canonical — extension/ loads unpacked with no build ` +
        "(engine bundle, blocklists, recipes, changelog)"
    );
  }

  return reporter;
}

if (require.main === module) {
  runCli(syncAudit);
}

module.exports = syncAudit;
