#!/usr/bin/env node
//
// Wipe the build output. Uses Node's `fs.rmSync` rather than `rm -rf`
// so the script runs on Windows without a POSIX shell.

import { rmSync } from 'node:fs';

rmSync('build', { recursive: true, force: true });
