import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from '../config/paths.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const deviceIdFile = (): string =>
  path.join(configDir(), 'telemetry-device-id');

/**
 * Random per-install identifier for usage analytics.
 *
 * Stored in its own file under `~/.browserless/`, deliberately NOT in
 * config.json: telemetry must never read-modify-write the file that holds the
 * API token, where a racing write could resurrect a just-cleared credential.
 *
 * Best-effort — any filesystem error falls back to an ephemeral id for this
 * run rather than breaking the command. A stored value that isn't a valid
 * UUID (e.g. hand-edited) is replaced.
 */
export const getOrCreateDeviceId = async (): Promise<string> => {
  const file = deviceIdFile();
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim();
    if (UUID_RE.test(existing)) return existing;
  } catch {
    // missing / unreadable — fall through and create one
  }

  const fresh = randomUUID();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Exclusive create handles the genuine missing-file race cleanly.
    await fs.writeFile(file, fresh, { flag: 'wx', mode: 0o600 });
    return fresh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
      return fresh;
    }
    // The file already existed. Either a concurrent run wrote a valid id
    // (use theirs, so all runs converge), or it holds corrupt/hand-edited
    // content — in which case repair it with a plain (truncating) write so
    // the id stops regenerating every run.
    try {
      const raced = (await fs.readFile(file, 'utf8')).trim();
      if (UUID_RE.test(raced)) return raced;
      // Repair a corrupt file. `mode` is only honored on create, and this file
      // already exists, so chmod explicitly to keep ~/.browserless's 0600.
      await fs.writeFile(file, fresh, { mode: 0o600 });
      await fs.chmod(file, 0o600).catch(() => undefined);
      return fresh;
    } catch {
      return fresh;
    }
  }
};
