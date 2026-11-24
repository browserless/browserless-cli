/**
 * One-time fixture builder.
 *
 * Spawns the user's local Chrome (or another Chromium-based browser)
 * headless against a temporary user-data-dir, sets a small predictable
 * cookie via CDP, and snapshots the result into `fixtures/chrome-profile/`.
 *
 * The output is the smallest possible Chrome profile that still
 * round-trips through `Storage.getCookies` — used by future capture
 * pipeline tests that need a real, decryptable profile.
 *
 * Run: `npm run fixture:build -- --browser chrome`
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import {
  BUILT_IN_BROWSERS,
  findBuiltInByKeyOrName,
} from '../build/browsers/registry.js';
import {
  pickFreePort,
  waitForDebuggerEndpoint,
  killBrowser,
} from '../build/capture/launch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..', 'fixtures', 'chrome-profile');

const parseArgs = () => {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--browser');
  if (idx === -1 || !args[idx + 1]) {
    throw new Error(
      'Usage: build-fixture-profile --browser <chrome|brave|edge|...>',
    );
  }
  return { browserKey: args[idx + 1] };
};

const main = async () => {
  const { browserKey } = parseArgs();
  const entry = findBuiltInByKeyOrName(browserKey);
  if (!entry) {
    throw new Error(
      `Unknown browser "${browserKey}". Known: ${BUILT_IN_BROWSERS.map((b) => b.key).join(', ')}`,
    );
  }
  const binaryCandidates = entry.binaryPathByPlatform[process.platform] ?? [];
  let binary = null;
  for (const candidate of binaryCandidates) {
    try {
      await fs.access(candidate);
      binary = candidate;
      break;
    } catch {
      // try the next one
    }
  }
  if (!binary) {
    throw new Error(
      `Could not find a ${entry.displayName} binary at any of: ${binaryCandidates.join(', ')}`,
    );
  }

  const tempUserDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'browserless-cli-fixture-'),
  );
  const port = await pickFreePort();

  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tempUserDataDir}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', () => undefined);

  try {
    await waitForDebuggerEndpoint(port);

    const client = await CDP({ port });
    try {
      await client.Storage.setCookies({
        cookies: [
          {
            name: 'fixture',
            value: 'browserless',
            domain: 'fixture.example.com',
            path: '/',
            httpOnly: false,
            secure: true,
            session: false,
            expires: Math.floor(Date.now() / 1000) + 86400,
          },
        ],
      });
    } finally {
      await client.close();
    }
  } finally {
    await killBrowser(child);
  }

  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.mkdir(fixtureRoot, { recursive: true });

  for (const name of ['Local State', 'First Run']) {
    const src = path.join(tempUserDataDir, name);
    if (
      await fs
        .access(src)
        .then(() => true)
        .catch(() => false)
    ) {
      await fs.cp(src, path.join(fixtureRoot, name)).catch(() => undefined);
    }
  }

  const sourceProfileDir = path.join(tempUserDataDir, 'Default');
  const targetProfileDir = path.join(fixtureRoot, 'Default');
  await fs.cp(sourceProfileDir, targetProfileDir, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(sourceProfileDir, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return ![
        'Cache',
        'Code Cache',
        'GPUCache',
        'GraphiteDawnCache',
        'ShaderCache',
        'Service Worker',
        'Crashpad',
        'optimization_guide_model_store',
        'Default Cache',
      ].includes(top);
    },
  });

  await fs.rm(tempUserDataDir, { recursive: true, force: true });

  console.log(`✓ Fixture profile written to ${fixtureRoot}`);
};

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
