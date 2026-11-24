import { expect } from 'chai';
import { Command } from 'commander';
import { setupTempHome } from '../test-helpers/temp-home.js';
import { startStubServer } from '../test-helpers/stub-server.js';
import { DEFAULT_SERVER } from '../config/schema.js';
import { recordToken, _resetRecordedTokenForTests } from './token-cache.js';
import { begin, complete, _resetForTests } from './index.js';
import { withProfileSetup } from './profile-setup.js';
import { ApiError } from '../errors.js';

describe('profile setup scenario', () => {
  it('batches deduplicated transitions with one UUID, distinct failures, and existing opt-out/region policy', async () => {
    const home = await setupTempHome();
    const stub = await startStubServer();
    const env = { ...process.env };
    const id = '72d3a05a-1fc5-430a-994a-794e23236d37';
    try {
      delete process.env.DO_NOT_TRACK;
      delete process.env.BROWSERLESS_TELEMETRY_DISABLED;
      process.env.BROWSERLESS_API_URL = stub.url;
      stub.setResponse(202, '{}');
      const run = async (operation: 'create' | 'refresh', fail = false) => {
        begin(new Command('upload'));
        try {
          await withProfileSetup(id, operation, async (setup) => {
            expect(setup.attemptId).to.equal(id);
            setup.ready();
            setup.ready();
            setup.submit();
            setup.submit();
            if (fail) throw new ApiError('secret-url-cookie-password', 400);
          });
        } catch {
          /* the real command still fails */
        }
        await complete(
          fail
            ? { status: 'error', exitCode: 5 }
            : { status: 'ok', exitCode: 0 },
        );
        await complete({ status: 'ok', exitCode: 0 });
      };
      recordToken({ token: 'synthetic', server: DEFAULT_SERVER });
      await run('create');
      const events = JSON.parse(stub.recorded[0].body).events;
      expect(events.map((e: any) => e.event_type)).to.deep.equal([
        'CLI Command Run',
        'Profile Setup Method Selected',
        'Profile Setup Started',
        'Profile Setup Ready',
        'Profile Save Submitted',
      ]);
      for (const event of events.slice(1))
        expect(event.event_properties).to.deep.equal({
          attempt_id: id,
          setup_method: 'cli',
          source: 'cli',
          operation: 'create',
        });
      await run('refresh', true);
      const failure = JSON.parse(stub.recorded[1].body).events.at(-1);
      expect(failure.event_properties).to.include({
        operation: 'refresh',
        step: 'save',
        reason_code: 'validation_rejected',
      });
      expect(stub.recorded[1].body).not.to.contain(
        'secret-url-cookie-password',
      );
      process.env.DO_NOT_TRACK = '1';
      await run('create');
      delete process.env.DO_NOT_TRACK;
      recordToken({ token: 'synthetic', server: stub.url });
      await run('create');
      expect(stub.recorded).to.have.length(2);
    } finally {
      process.env = env;
      _resetForTests();
      _resetRecordedTokenForTests();
      await stub.close();
      await home.cleanup();
    }
  });
});
