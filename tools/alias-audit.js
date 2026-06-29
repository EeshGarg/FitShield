#!/usr/bin/env node
"use strict";
/**
 * Alias audit. Aliases are alternate apex domains a brand owns; they are
 * matched and blocked alongside the primary domain, so collisions or malformed
 * values directly affect blocking accuracy.
 *
 * Errors: malformed alias, alias == its own primary, duplicate alias within an
 * entry, alias used by more than one entry, alias colliding with any primary
 * domain. Warnings: alias that is just the www-variant of its own primary.
 */

const { Reporter, runCli } = require("./lib/report");
const load = require("./lib/load");

function aliasAudit() {
  const reporter = new Reporter("Datasets — aliases");
  const datasets = load.loadDatasets().filter((d) => !d.error && Array.isArray(d.data.entries));

  // Every primary domain across both files, for collision detection.
  const primaries = new Set();
  datasets.forEach((ds) =>
    ds.data.entries.forEach((e) => primaries.add(String(e.domain || "").toLowerCase()))
  );

  const aliasOwner = new Map(); // alias -> "file[i] domain"
  let count = 0;

  datasets.forEach((ds) => {
    ds.data.entries.forEach((entry, i) => {
      if (entry.aliases === undefined) {
        return;
      }
      if (!Array.isArray(entry.aliases)) {
        reporter.fail(`${ds.name}[${i}] ${entry.domain}: aliases is not an array`);
        return;
      }

      const primary = String(entry.domain || "").toLowerCase();
      const within = new Set();

      entry.aliases.forEach((raw) => {
        const alias = String(raw || "").toLowerCase();
        const where = `${ds.name}[${i}] ${entry.domain}`;
        count += 1;

        if (!alias) {
          reporter.fail(`${where}: empty alias`);
          return;
        }
        if (!load.isApexDomain(alias)) {
          reporter.fail(`${where}: malformed alias "${alias}"`);
        }
        if (alias === primary) {
          reporter.fail(`${where}: alias equals its primary domain`);
        }
        if (alias === `www.${primary}` || `www.${alias}` === primary) {
          reporter.warn(`${where}: alias "${alias}" is just the www-variant`);
        }
        if (within.has(alias)) {
          reporter.fail(`${where}: duplicate alias "${alias}" within the entry`);
        }
        within.add(alias);

        if (primaries.has(alias)) {
          reporter.fail(`${where}: alias "${alias}" collides with a primary domain`);
        }
        if (aliasOwner.has(alias)) {
          reporter.fail(`${where}: alias "${alias}" already used by ${aliasOwner.get(alias)}`);
        } else {
          aliasOwner.set(alias, `${ds.name}[${i}] ${entry.domain}`);
        }
      });
    });
  });

  reporter.note(`${count} aliases across ${aliasOwner.size} distinct values`);
  return reporter;
}

if (require.main === module) {
  runCli(aliasAudit);
}

module.exports = aliasAudit;
