import { expect } from 'chai';
import sinon from 'sinon';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupTempHome, TempHome } from '../test-helpers/temp-home.js';
import { startStubServer, StubServer } from '../test-helpers/stub-server.js';
import { updateConfig } from '../config/store.js';
import { configDir } from '../config/paths.js';
import { DEFAULT_SERVER } from '../config/schema.js';
import { ApiError } from '../errors.js';
import { recordToken, _resetRecordedTokenForTests } from './token-cache.js';
import {
  installThrowingKeychain,
  uninstallFakeKeychain,
} from '../test-helpers/mock-keychain.js';
import * as telemetry from './index.js';

const ENV_KEYS = [
  'BROWSERLESS_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
  'BROWSERLESS_API_URL',
  'BROWSERLESS_TOKEN',
  'BROWSERLESS_TELEMETRY_TIMEOUT_MS',
  'BROWSERLESS_TELEMETRY_DEBUG',
  'CI',
];

// Parse a real `browserless profile list --json` and return the action
// command — the same object the preAction hook hands to telemetry.begin.
const profileListCommand = (): Command => {
  const program = new Command();
  program.exitOverride();
  let captured: Command | undefined;
  program
    .command('profile')
    .command('list')
    .option('--json')
    .action((_options: unknown, command: Command) => {
      captured = command;
    });
  program.parse(['profile', 'list', '--json'], { from: 'user' });
  if (!captured) throw new Error('action was not invoked');
  return captured;
};

describe('telemetry facade', () => {
  let home: TempHome;
  let stub: StubServer;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    home = await setupTempHome();
    stub = await startStubServer();
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    _resetRecordedTokenForTests();
    telemetry._resetForTests();
  });
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    uninstallFakeKeychain();
    await stub.close();
    await home.cleanup();
  });

  describe('isEnabled', () => {
    it('is enabled by default', async () => {
      expect(await telemetry.isEnabled()).to.equal(true);
    });
    it('is disabled by BROWSERLESS_TELEMETRY_DISABLED', async () => {
      process.env.BROWSERLESS_TELEMETRY_DISABLED = '1';
      expect(await telemetry.isEnabled()).to.equal(false);
    });
    it('is disabled by DO_NOT_TRACK=1', async () => {
      process.env.DO_NOT_TRACK = '1';
      expect(await telemetry.isEnabled()).to.equal(false);
    });
    it('DO_NOT_TRACK=1 wins over an explicit telemetry: true config', async () => {
      await updateConfig((c) => {
        c.telemetry = true;
      });
      process.env.DO_NOT_TRACK = '1';
      expect(await telemetry.isEnabled()).to.equal(false);
    });
    it('BROWSERLESS_TELEMETRY_DISABLED=1 wins over an explicit telemetry: true config', async () => {
      await updateConfig((c) => {
        c.telemetry = true;
      });
      process.env.BROWSERLESS_TELEMETRY_DISABLED = '1';
      expect(await telemetry.isEnabled()).to.equal(false);
    });
    it('BROWSERLESS_TELEMETRY_DISABLED=0 does not re-enable over DO_NOT_TRACK=1', async () => {
      process.env.BROWSERLESS_TELEMETRY_DISABLED = '0';
      process.env.DO_NOT_TRACK = '1';
      expect(await telemetry.isEnabled()).to.equal(false);
    });
    it('is disabled by the telemetry config key', async () => {
      await updateConfig((c) => {
        c.telemetry = false;
      });
      expect(await telemetry.isEnabled()).to.equal(false);
    });
    it('fails closed on a hand-edited string "false"', async () => {
      await home.writeRawConfig(
        'config.json',
        JSON.stringify({ telemetry: 'false' }),
      );
      expect(await telemetry.isEnabled()).to.equal(false);
    });
    it('fails closed when the config is corrupt', async () => {
      await home.writeRawConfig('config.json', '{ not valid json');
      expect(await telemetry.isEnabled()).to.equal(false);
    });
    it('treats DO_NOT_TRACK=0 as not opting out', async () => {
      process.env.DO_NOT_TRACK = '0';
      expect(await telemetry.isEnabled()).to.equal(true);
    });
  });

  describe('flushTimeoutMs', () => {
    it('defaults to 2000 when unset, non-positive, or non-numeric', () => {
      expect(telemetry.flushTimeoutMs()).to.equal(2000);
      process.env.BROWSERLESS_TELEMETRY_TIMEOUT_MS = '-1';
      expect(telemetry.flushTimeoutMs()).to.equal(2000);
      process.env.BROWSERLESS_TELEMETRY_TIMEOUT_MS = 'abc';
      expect(telemetry.flushTimeoutMs()).to.equal(2000);
    });
    it('uses a positive numeric override', () => {
      process.env.BROWSERLESS_TELEMETRY_TIMEOUT_MS = '500';
      expect(telemetry.flushTimeoutMs()).to.equal(500);
    });
  });

  describe('bucketServerUrl', () => {
    it('maps a production region URL to its code', () => {
      expect(
        telemetry.bucketServerUrl('https://production-lon.browserless.io'),
      ).to.equal('lon');
    });
    it('ignores a trailing slash (compares origins)', () => {
      expect(telemetry.bucketServerUrl(`${DEFAULT_SERVER}/`)).to.equal('sfo');
    });
    it('buckets a self-hosted server to "custom"', () => {
      expect(
        telemetry.bucketServerUrl('https://self-hosted.example.com'),
      ).to.equal('custom');
    });
    it('buckets an unparseable value to "custom"', () => {
      expect(telemetry.bucketServerUrl('not a url')).to.equal('custom');
    });
  });

  describe('complete', () => {
    const begin = () => telemetry.begin(profileListCommand());

    it('skips an untrusted API host without fetching or logging the token', async () => {
      process.env.BROWSERLESS_API_URL = 'https://attacker.example';
      process.env.BROWSERLESS_TELEMETRY_DEBUG = '1';
      recordToken({ token: 'secret-cloud-token', server: DEFAULT_SERVER });
      const fetch = sinon
        .stub(globalThis, 'fetch')
        .resolves(new Response('{}'));
      const stderr = sinon.stub(process.stderr, 'write').returns(true);
      try {
        begin();
        await telemetry.complete({ status: 'ok', exitCode: 0 });
        expect(fetch.callCount).to.equal(0);
        const output = stderr.args.map(([chunk]) => String(chunk)).join('');
        expect(output).to.contain(
          'skipped: BROWSERLESS_API_URL is not a Browserless host',
        );
        expect(output).not.to.contain('secret-cloud-token');
      } finally {
        fetch.restore();
        stderr.restore();
      }
    });

    it('posts one minimal CLI Command Run event when cloud-authenticated', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      stub.setResponse(202, '{"success":true}');
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      begin();
      await telemetry.complete({ status: 'ok', exitCode: 0 });

      expect(stub.recorded).to.have.length(1);
      const body = stub.recorded[0].body;
      const event = JSON.parse(body).events[0];
      expect(event.event_type).to.equal('CLI Command Run');
      expect(event.event_properties.command).to.equal('profile list');
      expect(event.event_properties.flags).to.deep.equal(['json']);
      expect(event.event_properties.status).to.equal('ok');
      expect(event.event_properties.server_region).to.equal('sfo');

      // Exact key set — adding a property to the payload must update this.
      expect(Object.keys(event.event_properties).sort()).to.deep.equal([
        'arch',
        'cli_device_id',
        'cli_version',
        'command',
        'duration_ms',
        'exit_code',
        'flags',
        'is_ci',
        'node_major',
        'os',
        'server_region',
        'status',
      ]);
      // Neither the raw token nor the raw server URL may appear in the body.
      expect(body).to.not.contain('tok-xyz');
      expect(body).to.not.contain('production-sfo');
      expect(stub.recorded[0].headers.authorization).to.equal('Bearer tok-xyz');

      // The id matches the one persisted to the device-id file.
      const persisted = (
        await fs.readFile(path.join(configDir(), 'telemetry-device-id'), 'utf8')
      ).trim();
      expect(event.event_properties.cli_device_id).to.equal(persisted);
    });

    it('does not post when telemetry is disabled', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      process.env.BROWSERLESS_TELEMETRY_DISABLED = '1';
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      begin();
      await telemetry.complete({ status: 'ok', exitCode: 0 });
      expect(stub.recorded).to.have.length(0);
    });

    it('does not post when disabled via the telemetry config key', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      await updateConfig((c) => {
        c.telemetry = false;
      });
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      begin();
      await telemetry.complete({ status: 'ok', exitCode: 0 });
      expect(stub.recorded).to.have.length(0);
    });

    it('does not post when DO_NOT_TRACK is set', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      process.env.DO_NOT_TRACK = '1';
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      begin();
      await telemetry.complete({ status: 'ok', exitCode: 0 });
      expect(stub.recorded).to.have.length(0);
    });

    it('emits at most one event per command (second complete is a no-op)', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      stub.setResponse(202, '{"success":true}');
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      begin();
      await telemetry.complete({ status: 'ok', exitCode: 0 });
      // pending is cleared on the first call, so a second flush (e.g. if both
      // postAction and the error catch ever fired) sends nothing more.
      await telemetry.complete({ status: 'error', exitCode: 1 });
      expect(stub.recorded).to.have.length(1);
    });

    it('does not post when no token was resolved this run', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      begin();
      await telemetry.complete({ status: 'ok', exitCode: 0 });
      expect(stub.recorded).to.have.length(0);
    });

    it('does not post when the token was resolved for a self-hosted server', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      recordToken({
        token: 'tok-xyz',
        server: 'https://self-hosted.example.com',
      });
      begin();
      await telemetry.complete({ status: 'ok', exitCode: 0 });
      expect(stub.recorded).to.have.length(0);
    });

    it('is a no-op when no command was started', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      await telemetry.complete({ status: 'ok', exitCode: 0 });
      expect(stub.recorded).to.have.length(0);
    });

    it('resolves without throwing when the endpoint is unreachable', async () => {
      // api.browserless.io stand-in points at a closed port → POST rejects,
      // which complete() must swallow (cli.ts relies on this not rejecting).
      process.env.BROWSERLESS_API_URL = 'http://127.0.0.1:1';
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      begin();
      await telemetry.complete({ status: 'ok', exitCode: 0 });
      expect(stub.recorded).to.have.length(0);
    });

    it('uses the recorded token and never reads the keychain', async () => {
      // A throwing keychain would surface as 0 events (complete swallows the
      // throw) if complete ever fell back to resolveToken; sending the event
      // proves it used the in-process cache and never touched the keychain.
      installThrowingKeychain('keychain must not be read by telemetry');
      process.env.BROWSERLESS_API_URL = stub.url;
      stub.setResponse(202, '{"success":true}');
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      begin();
      await telemetry.complete({ status: 'ok', exitCode: 0 });
      expect(stub.recorded).to.have.length(1);
    });

    it('does not fall back to the keychain when no token was recorded', async () => {
      installThrowingKeychain('keychain must not be read by telemetry');
      process.env.BROWSERLESS_API_URL = stub.url;
      begin();
      await telemetry.complete({ status: 'ok', exitCode: 0 });
      expect(stub.recorded).to.have.length(0);
    });

    it('posts classified failures without message or body text', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      stub.setResponse(202, '{"success":true}');
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      begin();
      await telemetry.complete(
        telemetry.errorResult(new ApiError('boom', 404, 'private-body'), 5),
      );
      const body = stub.recorded[0].body;
      expect(JSON.parse(body).events[0].event_properties).to.include({
        status: 'error',
        exit_code: 5,
        error_name: 'ApiError',
        error_code: 'not-found',
        error_category: 'api',
        http_status: 404,
      });
      expect(body).not.to.contain('boom');
      expect(body).not.to.contain('private-body');
    });

    it('maps supplied failure classification into the event', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      begin();
      await telemetry.complete({
        status: 'error',
        exitCode: 5,
        errorCode: 'not-found',
        errorCategory: 'api',
        httpStatus: 404,
      });
      expect(
        JSON.parse(stub.recorded[0].body).events[0].event_properties,
      ).to.include({
        error_code: 'not-found',
        error_category: 'api',
        http_status: 404,
      });
    });

    it('maps an error outcome into the event', async () => {
      process.env.BROWSERLESS_API_URL = stub.url;
      stub.setResponse(202, '{"success":true}');
      recordToken({ token: 'tok-xyz', server: DEFAULT_SERVER });
      begin();
      await telemetry.complete({
        status: 'error',
        exitCode: 3,
        errorName: 'PreconditionError',
        errorCode: 'no-token',
      });
      const event = JSON.parse(stub.recorded[0].body).events[0];
      expect(event.event_properties.status).to.equal('error');
      expect(event.event_properties.exit_code).to.equal(3);
      expect(event.event_properties.error_name).to.equal('PreconditionError');
      expect(event.event_properties.error_code).to.equal('no-token');
    });
  });
});
