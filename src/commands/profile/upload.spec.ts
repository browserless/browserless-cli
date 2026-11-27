import { expect } from 'chai';
import { Command } from 'commander';
import sinon from 'sinon';
import { CaptureError, UsageError } from '../../errors.js';
import { runCapture } from '../../cli-utils/capture-runner.js';
import { setupTempHome, TempHome } from '../../test-helpers/temp-home.js';
import * as telemetry from '../../telemetry/index.js';
import { _resetRecordedTokenForTests } from '../../telemetry/token-cache.js';
import { registerUpload } from './upload.js';
import { startStubServer } from '../../test-helpers/stub-server.js';

describe('commands/profile/upload telemetry', () => {
  let home: TempHome;
  let sandbox: sinon.SinonSandbox;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    home = await setupTempHome();
    sandbox = sinon.createSandbox();
    savedEnv = {};
    for (const key of ['BROWSERLESS_TELEMETRY_DISABLED', 'DO_NOT_TRACK']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    telemetry._resetForTests();
    _resetRecordedTokenForTests();
  });

  afterEach(async () => {
    _resetRecordedTokenForTests();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    sandbox.restore();
    await home.cleanup();
  });

  it('escapes uploaded profile display fields and preserves JSON values', async () => {
    process.env.BROWSERLESS_TELEMETRY_DISABLED = '1';
    const stub = await startStubServer();
    const name = 'work\x1b[2J';
    const profile = {
      name,
      id: name,
      cookieCount: 1,
      originCount: 2,
      createdAt: name,
      updatedAt: name,
      lastUsedAt: null,
    };
    stub.setResponse(200, JSON.stringify(profile));
    const stdout: string[] = [];
    sandbox.stub(console, 'log').callsFake((line) => {
      stdout.push(String(line));
    });
    sandbox.stub(process.stdout, 'write').callsFake((line) => {
      stdout.push(String(line));
      return true;
    });
    sandbox.stub(process.stderr, 'write').returns(true);
    try {
      for (const { json, sourceArgs, expectedSource } of [
        {
          json: false,
          sourceArgs: [],
          expectedSource: { browser: 'picker-b', profile: 'Profile 2' },
        },
        {
          json: true,
          sourceArgs: ['--browser', 'Google Chrome', '--profile', 'Work'],
          expectedSource: { browser: 'picker-b', profile: 'Profile 2' },
        },
        {
          json: true,
          sourceArgs: ['--profile', 'Work'],
          expectedSource: { browser: 'picker-b', profile: 'Profile 2' },
        },
        {
          json: true,
          sourceArgs: ['--browser', 'PICKER-B'],
          expectedSource: { browser: 'picker-b', profile: 'Profile 2' },
        },
      ]) {
        stdout.length = 0;
        const program = new Command();
        registerUpload(program, {
          runCapture: async () => {
            return {
              source: { browser: 'picker-b', profile: 'Profile 2' },
              state: { cookies: [], origins: [] },
              serialized: '{"cookies":[],"origins":[]}',
              capHit: false,
              passwordStoreDefaulted: false,
              diagnostics: {
                cookieCountBeforeExclusion: 0,
                cookieCountExcluded: 0,
                originCountBeforeExclusion: 0,
                originCountExcluded: 0,
                originCountSkippedByOnlyDomain: 0,
                excludedDomains: [],
                onlyDomains: [],
                durationMs: 0,
                failedOrigins: [],
              },
            };
          },
        });
        await program.parseAsync(
          [
            'upload',
            '--name',
            'work',
            ...sourceArgs,
            '--token',
            'test',
            '--server',
            stub.url,
            ...(json ? ['--json'] : []),
          ],
          { from: 'user' },
        );
        expect(
          JSON.parse(stub.recorded.at(-1)!.body).captureSettings,
        ).to.include(expectedSource);
        if (json) expect(JSON.parse(stdout.join(''))).to.deep.equal(profile);
        else {
          expect(stdout.join('\n')).to.include('work\\u001b[2J');
          expect(stdout.join('\n')).not.to.include('\x1b');
        }
      }
    } finally {
      await stub.close();
    }
  });

  for (const reason of ['capture_failed', 'validation_rejected'] as const) {
    it(`posts Started and ${reason} when capture fails after token resolution`, async () => {
      const failure = new CaptureError(
        'capture failed',
        'browser-launch-failed',
      );
      const posted: Array<{ url: string; init?: RequestInit }> = [];
      sandbox.stub(globalThis, 'fetch').callsFake(async (input, init) => {
        posted.push({ url: input.toString(), init });
        return new Response('', { status: 202 });
      });

      const program = new Command();
      program.exitOverride();
      registerUpload(program, {
        runCapture:
          reason === 'capture_failed'
            ? async () => {
                throw failure;
              }
            : (params) =>
                runCapture({
                  ...params,
                  sourceSeams: {
                    isInteractive: false,
                    loadCandidates: async () => [],
                  },
                }),
      });
      program.hook('preAction', (_command, actionCommand) => {
        telemetry.begin(actionCommand);
      });

      let caught: unknown;
      try {
        await program.parseAsync(
          [
            'upload',
            '--name',
            'work',
            ...(reason === 'capture_failed'
              ? ['--browser', 'chrome', '--profile', 'Default']
              : []),
            '--token',
            'tok-upload',
          ],
          { from: 'user' },
        );
      } catch (error) {
        if (!(error instanceof CaptureError || error instanceof UsageError))
          throw error;
        caught = error;
        await telemetry.complete({
          status: 'error',
          exitCode: error.exitCode,
          errorName: error.name,
          errorCode: error.code,
        });
      }

      if (reason === 'capture_failed') expect(caught).to.equal(failure);
      else
        expect(caught)
          .to.be.instanceOf(UsageError)
          .with.property('code', 'missing-required-flag');
      expect(posted).to.have.length(1);
      expect(posted[0].init?.headers).to.deep.include({
        Authorization: 'Bearer tok-upload',
      });
      const events = JSON.parse(String(posted[0].init?.body)).events;
      expect(
        events.map((event: { event_type: string }) => event.event_type),
      ).to.include.members(['Profile Setup Started', 'Profile Setup Failed']);
      expect(events[0].event_properties).to.include({ server_region: 'sfo' });
      const failed = events.find(
        (event: { event_type: string }) =>
          event.event_type === 'Profile Setup Failed',
      );
      expect(failed.event_properties).to.include({
        step: 'capture',
        reason_code: reason,
      });
    });
  }
});
