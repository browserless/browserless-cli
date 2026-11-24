#!/usr/bin/env node
//
// Minify the publish build in-place. Runs after `build-publish.mjs`
// emits commented-stripped JS into `build/` and before
// `strip-test-artifacts.mjs` drops the test-helper / spec files.
//
// `minify: true` collapses whitespace and shortens local variables,
// but `keepNames: true` preserves function / class names so end-user
// stack traces stay readable. Identifiers in error subclasses
// (`UsageError`, `PreconditionError`, …) and `Error.stack` frames
// remain intact — this is minification, not obfuscation.
//
// Wired into `prepack` in package.json.

import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'build';

const walkJs = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
};

const entryPoints = walkJs(ROOT);

await build({
  entryPoints,
  outdir: ROOT,
  allowOverwrite: true,
  // Whitespace + dead-code + short local identifiers only — exported
  // names and stack frames stay readable.
  minify: true,
  keepNames: true,
  // Each input file maps 1:1 to an output file in the same relative
  // path — no rollup-style bundling, so `commands/profile/upload.js`
  // can still resolve sibling imports through their original specifiers.
  bundle: false,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});
