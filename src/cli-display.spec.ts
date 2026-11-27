import { expect } from 'chai';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubServer, StubServer } from './test-helpers/stub-server.js';
import { setupTempHome, TempHome } from './test-helpers/temp-home.js';
import { terminalSafe } from './utils/terminal.js';

describe('CLI terminal-safe display', () => {
  let stub: StubServer;
  let home: TempHome;
  const hostile = 'café\\u001b\x1b]52;c;YQ==\x07\x1b[2J\x9b31m\r\n\t\b\x7f end';
  const safe =
    'café\\u001b\\u001b]52;c;YQ==\\u0007\\u001b[2J\\u009b31m\\u000d\\u000a\\u0009\\u0008\\u007f end';

  beforeEach(async () => {
    stub = await startStubServer();
    home = await setupTempHome();
  });
  afterEach(async () => {
    await stub.close();
    await home.cleanup();
  });

  it('lists safe explicit source flags when inspect cannot prompt', async () => {
    const userDataDir = path.join(home.path, 'browser-data');
    await fs.mkdir(path.join(userDataDir, 'Default'), { recursive: true });
    await fs.writeFile(path.join(userDataDir, 'Default', 'Preferences'), '{}');
    await fs.writeFile(
      path.join(userDataDir, 'Local State'),
      JSON.stringify({
        profile: { info_cache: { Default: { name: 'Evil\x1b[31mName' } } },
      }),
    );
    await home.writeRawConfig(
      'custom-browsers.json',
      JSON.stringify([
        { name: 'hostile-browser', binaryPath: process.execPath, userDataDir },
        { name: 'Browser Team', binaryPath: process.execPath, userDataDir },
        { name: 'browser; invalid', binaryPath: process.execPath, userDataDir },
      ]),
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./cli.js', import.meta.url)),
        'profile',
        'inspect',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
        env: {
          ...process.env,
          HOME: home.path,
          USERPROFILE: home.path,
          BROWSERLESS_TELEMETRY_DISABLED: '1',
        },
      },
    );
    expect(result.status, result.stderr).to.equal(2);
    expect(result.stderr).to.include(
      '--browser and --profile are required when the CLI cannot ask',
    );
    expect(result.stderr).to.include(
      '--browser hostile-browser --profile "Default"',
    );
    expect(result.stderr).to.include(
      '--browser "Browser Team" --profile "Default"',
    );
    expect(result.stderr).not.to.include('--browser browser;');
    expect(result.stderr).to.include('Evil\\u001b[31mName');
    expect(result.stderr).not.to.include('\x1b');
    expect(result.stderr).not.to.include(userDataDir);
  });

  const run = (args: string[]) =>
    new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(new URL('./cli.js', import.meta.url)),
            'profile',
            ...args,
            '--server',
            stub.url,
            '--token',
            'test-token',
          ],
          {
            env: {
              ...process.env,
              HOME: home.path,
              USERPROFILE: home.path,
              BROWSERLESS_TELEMETRY_DISABLED: '1',
            },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ stdout, stderr, code }));
      },
    );

  for (const json of [true, false]) {
    it(`escapes ${json ? 'JSON message' : 'text body'} errors and keeps the API exit code`, async () => {
      stub.setResponse(
        400,
        json ? JSON.stringify({ message: hostile }) : hostile,
      );
      const result = await run(['show', 'work']);
      expect(result.code).to.equal(5);
      expect(result.stderr).to.include(safe);
      expect(result.stderr.split('\n')).to.have.length(2);
      // eslint-disable-next-line no-control-regex
      expect(result.stderr).not.to.match(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      expect(result.stdout).to.equal('');
    });
  }

  it('keeps trusted CRLF layout and copyable Windows paths', () => {
    expect(
      terminalSafe('Default\\Network\\Cookies\r\n\tguidance\runsafe', {
        preserveLayout: true,
      }),
    ).to.equal('Default\\Network\\Cookies\n\tguidance\\u000dunsafe');
  });

  it('escapes bidi and invisible format controls without changing visible Unicode', () => {
    for (const [start, end] of [
      [0x00ad, 0x00ad],
      [0x061c, 0x061c],
      [0x180e, 0x180e],
      [0x200b, 0x200b],
      [0x200e, 0x200f],
      [0x202a, 0x202e],
      [0x2060, 0x2064],
      [0x2066, 0x206f],
      [0xfeff, 0xfeff],
      [0xe0000, 0xe007f],
    ]) {
      for (let code = start; code <= end; code++) {
        const escaped =
          code > 0xffff
            ? `\\u{${code.toString(16)}}`
            : `\\u${code.toString(16).padStart(4, '0')}`;
        expect(terminalSafe(`café${String.fromCodePoint(code)}世界`)).to.equal(
          `café${escaped}世界`,
        );
      }
    }
  });

  it('preserves text joiners, emoji and characters outside the escaped ranges', () => {
    const text = '👨‍👩‍👧 می\u200cروم क्\u200dष \u2065\u{dffff}\u{e0080}';
    expect(terminalSafe(text)).to.equal(text);
  });

  it('preserves complete subdivision flags but escapes other tag characters', () => {
    const flags = [
      '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}',
      '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}',
      '\u{1f3f4}\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}',
    ].join(' ');
    for (const preserveLayout of [false, true]) {
      expect(
        terminalSafe(`${flags}\u{e0061}\u{e007f} 🏴\u{e0067}`, {
          preserveLayout,
        }),
      ).to.equal(`${flags}\\u{e0061}\\u{e007f} 🏴\\u{e0067}`);
    }
  });

  it('keeps application-authored profile guidance on separate lines', async () => {
    const userDataDir = path.join(home.path, 'browser-data');
    for (const dir of ['Default', 'Profile 1']) {
      await fs.mkdir(path.join(userDataDir, dir), { recursive: true });
      await fs.writeFile(path.join(userDataDir, dir, 'Preferences'), '{}');
    }
    await home.writeRawConfig(
      'custom-browsers.json',
      JSON.stringify([
        { name: 'test-browser', binaryPath: process.execPath, userDataDir },
      ]),
    );
    const result = await run([
      'upload',
      '--name',
      'work',
      '--browser',
      'test-browser',
      '--profile',
      'typo',
    ]);
    expect(result.code).to.equal(2);
    expect(result.stderr).to.match(/Available profiles:\n {2}- [^\n]+\n {2}- /);
    expect(result.stderr).not.to.include('\\u000a');
  });

  it('refuses to refresh a deleted saved directory that matches another profile by name', async () => {
    const userDataDir = path.join(home.path, 'browser-data');
    await fs.mkdir(path.join(userDataDir, 'Profile 1'), { recursive: true });
    await fs.writeFile(
      path.join(userDataDir, 'Profile 1', 'Preferences'),
      '{}',
    );
    await fs.writeFile(
      path.join(userDataDir, 'Local State'),
      JSON.stringify({
        profile: { info_cache: { 'Profile 1': { name: 'Default' } } },
      }),
    );
    await home.writeRawConfig(
      'custom-browsers.json',
      JSON.stringify([
        { name: 'test-browser', binaryPath: process.execPath, userDataDir },
      ]),
    );
    stub.setResponse(
      200,
      JSON.stringify({
        captureSettings: {
          browser: 'test-browser',
          profile: 'Default',
          cliVersion: '0.8.0',
        },
      }),
    );
    const result = await run(['refresh', '--name', 'work']);
    expect(result.code).to.equal(2);
    expect(result.stderr).to.include('Saved profile directory "Default"');
    expect(stub.recorded.map(({ method }) => method)).to.deep.equal(['GET']);
  });

  for (const args of [
    ['show', 'work'],
    ['list'],
    ['rename', 'work', 'new'],
    ['delete', 'work'],
  ]) {
    it(`escapes ${args[0]} display fields but preserves structured output`, async () => {
      const profile = {
        name: hostile,
        id: hostile,
        cookieCount: 3,
        originCount: 2,
        createdAt: hostile,
        updatedAt: hostile,
        lastUsedAt: hostile,
      };
      const body = args[0] === 'list' ? [profile] : profile;
      stub.setResponse(200, JSON.stringify(body));
      const display = await run(args);
      expect(display.code).to.equal(0);
      expect(display.stdout).to.include(safe);
      // eslint-disable-next-line no-control-regex
      expect(display.stdout).not.to.match(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
      const structured = await run([...args, '--json']);
      expect(structured.code).to.equal(0);
      expect(JSON.parse(structured.stdout)).to.deep.equal(body);
    });
  }

  it('reports an invalid scripted refresh browser instead of missing settings', async () => {
    stub.setResponse(200, JSON.stringify({ captureSettings: {} }));
    const result = await run([
      'refresh',
      '--name',
      'work',
      '--browser',
      'not-a-browser',
    ]);
    expect(result.code).to.equal(2);
    expect(result.stderr).to.include('Unknown browser "not-a-browser"');
    expect(stub.recorded.map(({ method }) => method)).to.deep.equal(['GET']);
  });

  it('lists the replacement browser profiles without reusing a saved directory', async () => {
    const userDataDir = path.join(home.path, 'replacement-data');
    await fs.mkdir(path.join(userDataDir, 'Profile 1'), { recursive: true });
    await fs.writeFile(
      path.join(userDataDir, 'Profile 1', 'Preferences'),
      '{}',
    );
    await home.writeRawConfig(
      'custom-browsers.json',
      JSON.stringify([
        { name: 'replacement', binaryPath: process.execPath, userDataDir },
      ]),
    );
    stub.setResponse(
      200,
      JSON.stringify({
        captureSettings: {
          browser: 'chrome',
          profile: 'Profile 1',
          cliVersion: '0.8.0',
        },
      }),
    );
    const result = await run([
      'refresh',
      '--name',
      'work',
      '--browser',
      'replacement',
    ]);
    expect(result.code).to.equal(2);
    expect(result.stderr).to.include(
      '--browser replacement --profile "Profile 1"',
    );
    expect(stub.recorded.map(({ method }) => method)).to.deep.equal(['GET']);
  });
});
