#!/usr/bin/env node
//
// Publish build: wipe the dev artifacts (which carry JSDoc + sourcemaps)
// and rebuild with `tsconfig.publish.json` so the npm tarball ships
// minimised, comment-free JS only. Wired into `prepack` — runs on
// `npm pack` and `npm publish`.

import { execSync } from 'node:child_process';
import { chmodSync, rmSync } from 'node:fs';

rmSync('build', { recursive: true, force: true });
execSync('tsc -p tsconfig.publish.json', { stdio: 'inherit' });
chmodSync('build/cli.js', 0o755);
