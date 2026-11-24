// Strip test-only artifacts from `build/` before npm packs the tarball.
// Wired into the `prepack` script in package.json so it runs on both
// `npm publish` AND `npm pack` — that way `npm pack --dry-run` shows
// the same file list as `npm publish` would actually upload, instead
// of an inflated list that misleads the operator.
//
// Removes:
//   - any file with `.spec.` in its name (compiled `*.spec.ts`)
//   - everything under `build/test-helpers/` (mock-keychain, stub-server,
//     temp-home — only used by specs)
//
// Cross-platform (no `find`) so manual publishes from Windows still work.

import { readdirSync, unlinkSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'build';
const HELPERS_DIR = join(ROOT, 'test-helpers');

let filesRemoved = 0;
let dirsRemoved = 0;

const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.includes('.spec.')) {
      unlinkSync(full);
      filesRemoved++;
    }
  }
};

try {
  statSync(ROOT);
} catch {
  console.error(
    `strip-test-artifacts: "${ROOT}" not found — run \`npm run build\` first.`,
  );
  process.exit(1);
}

walk(ROOT);

try {
  statSync(HELPERS_DIR);
  rmSync(HELPERS_DIR, { recursive: true, force: true });
  dirsRemoved++;
} catch {
  // already absent — nothing to do
}

console.log(
  `strip-test-artifacts: removed ${filesRemoved} spec file(s)` +
    (dirsRemoved ? ` and ${HELPERS_DIR}/` : '') +
    ` from ${ROOT}/`,
);
