import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_HISTORY_ENTRIES,
  loadHistory,
  saveHistory,
} from './history.js';

describe('agent/history', function () {
  let tmpDir: string;
  let file: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-history-'));
    file = path.join(tmpDir, 'agent_history');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('loadHistory', function () {
    it('returns [] when the file does not exist', async function () {
      expect(await loadHistory(file)).to.deep.equal([]);
    });

    it('parses oldest-first lines and returns newest-first', async function () {
      // The on-disk format is oldest-first (shell convention).
      await fs.writeFile(file, 'first task\nsecond task\nthird task\n');
      const out = await loadHistory(file);
      expect(out).to.deep.equal(['third task', 'second task', 'first task']);
    });

    it('drops blank and whitespace-only lines', async function () {
      await fs.writeFile(file, '\nactual line\n   \n\nanother line\n');
      expect(await loadHistory(file)).to.deep.equal([
        'another line',
        'actual line',
      ]);
    });

    it('caps at MAX_HISTORY_ENTRIES', async function () {
      const lines = Array.from(
        { length: MAX_HISTORY_ENTRIES + 50 },
        (_, i) => `task ${i}`,
      );
      await fs.writeFile(file, `${lines.join('\n')}\n`);
      const out = await loadHistory(file);
      expect(out).to.have.length(MAX_HISTORY_ENTRIES);
      // Newest entries kept; the very latest written line wins.
      expect(out[0]).to.equal(`task ${MAX_HISTORY_ENTRIES + 49}`);
    });
  });

  describe('saveHistory', function () {
    it('writes oldest-first, one entry per line, with a trailing newline', async function () {
      // Caller hands us readline's newest-first array.
      await saveHistory(['third', 'second', 'first'], file);
      const content = await fs.readFile(file, 'utf-8');
      expect(content).to.equal('first\nsecond\nthird\n');
    });

    it('collapses adjacent duplicates', async function () {
      await saveHistory(['c', 'b', 'b', 'b', 'a'], file);
      const content = await fs.readFile(file, 'utf-8');
      expect(content).to.equal('a\nb\nc\n');
    });

    it('caps at MAX_HISTORY_ENTRIES', async function () {
      const newest = Array.from({ length: MAX_HISTORY_ENTRIES + 20 }, (_, i) =>
        i.toString(),
      );
      await saveHistory(newest, file);
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.trimEnd().split('\n');
      expect(lines.length).to.equal(MAX_HISTORY_ENTRIES);
      // We keep the head of `newest` (most recent). On-disk reversed → last
      // line is the newest entry, index 0.
      expect(lines[lines.length - 1]).to.equal('0');
    });

    it('writes with 0600 permissions (POSIX)', async function () {
      if (process.platform === 'win32') return this.skip();
      await saveHistory(['something'], file);
      const stat = await fs.stat(file);
      // Mask off the file-type bits; we only care about the permission triplet.
      expect(stat.mode & 0o777).to.equal(0o600);
    });

    it('creates the parent directory if missing', async function () {
      const nested = path.join(tmpDir, 'deep', 'nested', 'agent_history');
      await saveHistory(['x'], nested);
      const content = await fs.readFile(nested, 'utf-8');
      expect(content).to.equal('x\n');
    });
  });

  describe('round-trip', function () {
    it('saveHistory → loadHistory recovers the original order', async function () {
      const newestFirst = ['three', 'two', 'one'];
      await saveHistory(newestFirst, file);
      expect(await loadHistory(file)).to.deep.equal(newestFirst);
    });
  });
});
