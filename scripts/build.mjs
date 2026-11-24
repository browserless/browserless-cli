#!/usr/bin/env node
//
// Dev build: compile TypeScript and mark `build/cli.js` executable so the
// shebang line is honoured when the binary is invoked directly. `chmod`
// would be a one-liner on POSIX but doesn't exist on Windows; Node's
// `chmodSync` is a no-op for the +x bit on Windows, so this works
// uniformly across all three OSes the project supports.

import { execSync } from 'node:child_process';
import { chmodSync } from 'node:fs';

execSync('tsc -p tsconfig.json', { stdio: 'inherit' });
chmodSync('build/cli.js', 0o755);
