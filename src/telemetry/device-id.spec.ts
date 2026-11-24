import { expect } from 'chai';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupTempHome, TempHome } from '../test-helpers/temp-home.js';
import { configDir } from '../config/paths.js';
import { getOrCreateDeviceId } from './device-id.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idFile = () => path.join(configDir(), 'telemetry-device-id');
const exists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

describe('telemetry/device-id', () => {
  let home: TempHome;
  beforeEach(async () => {
    home = await setupTempHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  it('generates a UUID into its own file, never touching config.json', async () => {
    const id = await getOrCreateDeviceId();
    expect(id).to.match(UUID_RE);
    expect((await fs.readFile(idFile(), 'utf8')).trim()).to.equal(id);
    // Telemetry must not create or write the credential-bearing config file.
    expect(await exists(path.join(configDir(), 'config.json'))).to.equal(false);
  });

  it('reuses the persisted id on subsequent calls', async () => {
    const first = await getOrCreateDeviceId();
    const second = await getOrCreateDeviceId();
    expect(second).to.equal(first);
  });

  it('repairs a corrupt file and stays stable across runs', async () => {
    await fs.mkdir(configDir(), { recursive: true });
    await fs.writeFile(idFile(), 'not-a-uuid');

    const first = await getOrCreateDeviceId();
    expect(first).to.match(UUID_RE);
    // The corrupt content must be rewritten on disk, not left in place...
    expect((await fs.readFile(idFile(), 'utf8')).trim()).to.equal(first);
    // ...so a second run returns the same id instead of a fresh one.
    const second = await getOrCreateDeviceId();
    expect(second).to.equal(first);
  });

  it('repairs a corrupt file with 0600 permissions', async () => {
    if (process.platform === 'win32') return; // POSIX mode bits only
    await fs.mkdir(configDir(), { recursive: true });
    await fs.writeFile(idFile(), 'garbage', { mode: 0o644 });
    await getOrCreateDeviceId();
    expect((await fs.stat(idFile())).mode & 0o777).to.equal(0o600);
  });
});
