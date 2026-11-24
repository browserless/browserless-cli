import { expect } from 'chai';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import { WebSocketServer } from 'ws';
import { AgentClient } from '../../agent/ws-client.js';
import {
  runAgentChat,
  type AgentClientLike,
  type RunAgentChatDeps,
  type ChatOptions,
} from './chat.js';
import type { Prompts } from '../../cli-utils/prompts.js';
import { ApiError, UsageError } from '../../errors.js';
import { buildFirstTurn, LOGIN_TIP } from '../../cli-utils/agent-format.js';
import { expectRejects } from '../../test-helpers/assertions.js';

/**
 * EventEmitter-backed stand-in for `AgentClient`. Each `start`/`send` flushes
 * the next queued outcome on a macrotask so it lands *after* `waitForTurnEnd`
 * has subscribed — mirroring the real "send a frame, await the reply" cadence.
 */
class MockClient extends EventEmitter implements AgentClientLike {
  readonly sent: Array<{ type: 'start' | 'send'; text: string }> = [];
  private readonly outcomes: Array<(c: MockClient) => void>;
  connected = false;
  closed = false;
  stopCount = 0;

  constructor(outcomes: Array<(c: MockClient) => void> = []) {
    super();
    this.outcomes = outcomes;
  }
  async connect(): Promise<void> {
    this.connected = true;
  }
  start(prompt: string): void {
    this.sent.push({ type: 'start', text: prompt });
    this.flushNext();
  }
  send(prompt: string): void {
    this.sent.push({ type: 'send', text: prompt });
    this.flushNext();
  }
  stop(): void {
    this.stopCount += 1;
  }
  close(): void {
    this.closed = true;
  }
  private flushNext(): void {
    const next = this.outcomes.shift();
    if (next) setImmediate(() => next(this));
  }
}

interface PromptCall {
  method: 'line' | 'linePrivate';
  prompt: string;
}

/** Records every prompt call + the seam used, replaying queued answers. */
class RecordingPrompts implements Prompts {
  readonly calls: PromptCall[] = [];
  constructor(
    private readonly answers: {
      line?: string[];
      linePrivate?: string[];
    } = {},
  ) {}
  async line(prompt: string): Promise<string> {
    this.calls.push({ method: 'line', prompt });
    return this.answers.line?.shift() ?? '';
  }
  async linePrivate(prompt: string): Promise<string> {
    this.calls.push({ method: 'linePrivate', prompt });
    return this.answers.linePrivate?.shift() ?? '';
  }
}

const makeDeps = (client: MockClient): RunAgentChatDeps => ({
  buildClient: async () => ({
    server: 'https://stub.test',
    token: 'tok',
    source: 'flag',
  }),
  makeClient: () => client,
  getProfile: async () => ({
    id: 'profile_work',
    name: 'work',
    cookieCount: 1,
    originCount: 0,
    lastUsedAt: null,
    createdAt: '',
    updatedAt: '',
  }),
});

describe('commands/agent/chat — runAgentChat', function () {
  let sandbox: sinon.SinonSandbox;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    out = [];
    err = [];
    sandbox
      .stub(process.stdout, 'write')
      .callsFake((chunk: string | Uint8Array) => {
        out.push(chunk.toString());
        return true;
      });
    sandbox
      .stub(process.stderr, 'write')
      .callsFake((chunk: string | Uint8Array) => {
        err.push(chunk.toString());
        return true;
      });
  });
  afterEach(() => sandbox.restore());

  const run = (
    opts: ChatOptions,
    prompts: Prompts,
    client: MockClient,
  ): Promise<void> => runAgentChat(opts, prompts, makeDeps(client));

  describe('terminal-safe remote display', function () {
    it('escapes controls across streamed JSON and fragmented WebSocket frames', async function () {
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (typeof address === 'string' || !address) throw new Error('No port');
      server.on('connection', (ws) => {
        ws.once('message', () => {
          for (const text of [
            'café ',
            '\x1b',
            '[2J',
            '\x1b]52;c;',
            'YQ==',
            '\x07',
            '\x9b',
            '1G',
            '\r',
            '\n\tline two\r\n\x7f\x9f',
          ]) {
            const wire = JSON.stringify({ type: 'data', text });
            ws.send(wire.slice(0, 12), { fin: false });
            ws.send(wire.slice(12), { fin: true });
          }
          ws.send(JSON.stringify({ type: 'end', result: { success: true } }));
        });
      });
      try {
        await runAgentChat({ prompt: 'go' }, new RecordingPrompts(), {
          buildClient: async () => ({
            server: `http://127.0.0.1:${address.port}`,
            token: 't',
            source: 'flag',
          }),
          makeClient: (opts) => new AgentClient(opts),
          getProfile: makeDeps(new MockClient()).getProfile,
        });
        expect(out.join('')).to.contain(
          'café \\u001b[2J\\u001b]52;c;YQ==\\u0007\\u009b1G\n\tline two\n\\u007f\\u009f',
        );
        expect(out.join('')).to.not.contain('\x1b');
        expect(out.join('')).to.not.contain('\x9b');
      } finally {
        for (const ws of server.clients) ws.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('escapes an abnormal WebSocket close reason and rejects with ApiError', async function () {
      const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (typeof address === 'string' || !address) throw new Error('No port');
      server.on('connection', (ws) => {
        ws.once('message', () => {
          ws.close(1011, 'café\x1b]52;c;YQ==\x07\x9b2J\r\n\t');
        });
      });
      try {
        const error = await expectRejects(
          () =>
            runAgentChat({ prompt: 'go' }, new RecordingPrompts(), {
              buildClient: async () => ({
                server: `http://127.0.0.1:${address.port}`,
                token: 't',
                source: 'flag',
              }),
              makeClient: (opts) => new AgentClient(opts),
              getProfile: makeDeps(new MockClient()).getProfile,
            }),
          ApiError,
        );
        expect(error.code).to.equal('agent-session-error');
        expect(err.join('')).to.equal(
          'error: WebSocket closed abnormally (code 1011: café\\u001b]52;c;YQ==\\u0007\\u009b2J\n       \t)\n',
        );
      } finally {
        for (const ws of server.clients) ws.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    for (const json of [false, true]) {
      it(`escapes tool fields and result displays without changing JSON (json=${json})`, async function () {
        const result = {
          success: false,
          reason_code: 'why\x1b[2J',
          final_url: 'https://x/\x9d\u202e\u2066\u200b\ufeff',
          evidence: 'proof\r\nResult: success\n\t\x07\n',
        };
        const client = new MockClient([
          (c) => {
            c.emit('data', { text: 'answer\r\n\tcontinued' });
            c.emit('tool_call', {
              id: 'a',
              method: 'go\x1b',
              rationale: 'because\x07',
              params: { ['key\x9b']: 'v\r' },
            });
            c.emit('tool_result', { id: 'a', ok: true });
            c.emit('tool_call', {
              id: 'b',
              method: 'browserless_agent',
              params: { commands: [{ method: 'click\x1b' }] },
            });
            c.emit('tool_result', { id: 'b', ok: false });
            c.emit('end', { result });
          },
        ]);
        await run({ prompt: 'go', json }, new RecordingPrompts(), client);
        const display = (json ? err : out).join('');
        expect(display).to.contain('answer\n\tcontinued');
        expect(display).to.contain(
          'because\\u0007: go\\u001b key\\u009b=v\\u000d',
        );
        expect(display).to.contain('1 cmds: click\\u001b');
        expect(display).to.not.contain('\x1b');
        expect(display).to.not.contain('\x07');
        expect(display).to.not.contain('\x9b');
        if (json) {
          expect(JSON.parse(out.join(''))).to.deep.equal({
            type: 'end',
            result,
          });
        } else {
          expect(display).to.contain(
            '  reason_code: why\\u001b[2J\n  final_url: https://x/\\u009d\\u202e\\u2066\\u200b\\ufeff\n  evidence: proof\n            Result: success\n            \t\\u0007\n            ',
          );
        }
      });
    }

    for (const field of ['message', 'code']) {
      it(`escapes remote error ${field} while retaining retry behavior`, async function () {
        const client = new MockClient([
          (c) =>
            c.emit('agent_error', {
              [field]: 'remote\x1b]52;c;x\x07\r\nResult: success\n\tdetail\r\n',
              retryable: true,
            }),
        ]);
        await run({ prompt: 'go' }, new RecordingPrompts(), client);
        expect(err.join('')).to.equal(
          'error: remote\\u001b]52;c;x\\u0007\n       Result: success\n       \tdetail\n       \n',
        );
      });
    }

    it('falls back to the error code when the message is empty', async function () {
      const client = new MockClient([
        (c) =>
          c.emit('agent_error', {
            message: '',
            code: 'bad\u202e',
            retryable: true,
          }),
      ]);
      await run({ prompt: 'go' }, new RecordingPrompts(), client);
      expect(err.join('')).to.equal('error: bad\\u202e\n');
    });

    it('clips long tool text without truncating ANSI styles in a narrow TTY', async function () {
      if ('isTTY' in process.stdout)
        sandbox.stub(process.stdout, 'isTTY').value(true);
      else sandbox.define(process.stdout, 'isTTY', true);
      if ('columns' in process.stdout)
        sandbox.stub(process.stdout, 'columns').value(32);
      else sandbox.define(process.stdout, 'columns', 32);
      const noColor = process.env.NO_COLOR;
      delete process.env.NO_COLOR;
      try {
        const client = new MockClient([
          (c) => {
            c.emit('tool_call', {
              id: 'a',
              method: '😀go',
              params: { url: '\x1b'.repeat(12) },
            });
            c.emit('tool_result', { id: 'a', ok: true });
            c.emit('data', { text: 'next\n\tline' });
            c.emit('end', { result: null });
          },
        ]);
        await run({ prompt: 'go' }, new RecordingPrompts(), client);
        const rows = out.filter((chunk) => chunk.startsWith('\r\x1b[K'));
        expect(rows).to.have.length(2);
        for (const row of rows) {
          expect(row).to.contain('…');
          expect(row.endsWith('\x1b[0m')).to.equal(true);
          const plain = stripVTControlCharacters(row.slice(4));
          expect([...plain].length).to.equal(30);
          expect(plain).not.to.match(/[\ud800-\udfff]/u);
          expect(plain).to.contain('😀go');
          expect(plain).not.to.contain('\x1b');
        }
        expect(out.join('')).to.contain('next\n\tline');
      } finally {
        if (noColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = noColor;
      }
    });

    it('prints fallback rows for unmatched and repeated tool results and stops the spinner', async function () {
      if ('isTTY' in process.stdout)
        sandbox.stub(process.stdout, 'isTTY').value(true);
      else sandbox.define(process.stdout, 'isTTY', true);
      const clock = sandbox.useFakeTimers({
        toFake: ['setInterval', 'clearInterval'],
      });
      let completed = '';
      let afterTick = '';
      const client = new MockClient([
        (c) => {
          c.emit('data', { text: 'before' });
          c.emit('tool_call', { id: 'a', method: 'go', params: {} });
          c.emit('tool_result', { id: 'missing', ok: true });
          completed = out.join('');
          clock.tick(160);
          afterTick = out.join('');
          c.emit('data', { text: 'after\n' });
          c.emit('tool_result', { id: 'a', ok: true });
          c.emit('tool_result', { id: 'a', ok: false });
          c.emit('end', { result: null });
        },
      ]);
      await run({ prompt: 'go' }, new RecordingPrompts(), client);
      expect(afterTick).to.equal(completed);
      const display = stripVTControlCharacters(out.join('')).replace(/\r/g, '');
      expect(display).to.contain('✓ ?\nafter\n');
      expect(display).to.contain('✓ go\n✗ ?\n');
    });

    it('renders malformed tool fields without crashing the turn', async function () {
      const failures: unknown[] = [];
      const client = new MockClient([
        (c) => {
          const calls = [
            ...[null, true, 42, {}, []].map((rationale) => ({
              method: 'go',
              rationale,
            })),
            ...[null, 42, { toString: null }].map((method) => ({ method })),
            {
              method: 'browserless_agent',
              params: { method: { toString: null } },
            },
            {
              method: 'browserless_agent',
              params: {
                commands: [
                  null,
                  7,
                  'go',
                  {},
                  { method: null },
                  { method: 7 },
                  { method: {} },
                  { method: 'click' },
                ],
              },
            },
          ];
          for (const [i, call] of calls.entries()) {
            try {
              c.emit('tool_call', { id: String(i), ...call });
              c.emit('tool_result', { id: String(i), ok: true });
            } catch (error) {
              failures.push(error);
            }
          }
          c.emit('end', { result: { success: true } });
        },
      ]);
      await run({ prompt: 'go' }, new RecordingPrompts(), client);
      expect(failures).to.deep.equal([]);
      expect(out.join('')).to.contain(
        '8 cmds: ? → ? → ? → ? → ? → ? → ? → click',
      );
      expect(out.join('')).to.contain('Result: success');
    });
  });

  it('drives one turn from opts.prompt and exits on a blank follow-up', async function () {
    const client = new MockClient([
      (c) => c.emit('end', { result: { success: true } }),
    ]);
    const prompts = new RecordingPrompts({ line: [''] }); // blank → exit after turn 1

    await run({ prompt: 'hello there' }, prompts, client);

    expect(client.connected).to.equal(true);
    expect(client.sent).to.deep.equal([
      { type: 'start', text: buildFirstTurn('hello there') },
    ]);
    expect(client.closed).to.equal(true);
    // opts.prompt feeds turn 1 → the only `line` call is the exit prompt.
    expect(prompts.calls).to.deep.equal([{ method: 'line', prompt: '> ' }]);
  });

  describe('--json stdout discipline', function () {
    it('writes ONLY the final end JSON to stdout; banner + stream chrome to stderr', async function () {
      const client = new MockClient([
        (c) => {
          // streaming chrome during the turn — must never touch stdout
          c.emit('data', { text: 'thinking…' });
          c.emit('tool_call', {
            id: '1',
            method: 'goto',
            params: { url: 'x' },
          });
          c.emit('tool_result', { id: '1', ok: true });
          c.emit('end', { result: { success: true, reason_code: 'done' } });
        },
      ]);
      const prompts = new RecordingPrompts({ line: [''] });

      await run({ prompt: 'go', json: true }, prompts, client);

      const stdout = out.join('');
      // stdout is exactly one JSON document — the end payload.
      const parsed = JSON.parse(stdout);
      expect(parsed).to.deep.equal({
        type: 'end',
        result: { success: true, reason_code: 'done' },
      });
      // Nothing else leaked to stdout (banner, deltas, tool lines).
      expect(stdout).to.not.contain('thinking');
      expect(stdout).to.not.contain('agent →');
      // The banner went to stderr instead.
      expect(err.join('')).to.contain('agent →');
    });
  });

  describe('error dispatch', function () {
    it('throws ApiError when the server error is non-retryable', async function () {
      const client = new MockClient([
        (c) =>
          c.emit('agent_error', { message: 'fatal boom', retryable: false }),
      ]);
      const prompts = new RecordingPrompts();

      const e = await expectRejects(
        () => run({ prompt: 'go' }, prompts, client),
        ApiError,
      );
      expect(e.message).to.contain('Agent session ended with an error');
      expect(e.code).to.equal('agent-session-error');
      expect(e.status).to.equal(0);
      expect(err.join('')).to.contain('fatal boom');
      expect(client.closed).to.equal(true); // finally still ran
    });

    it('throws ApiError when retryable is absent (version skew → terminal)', async function () {
      const client = new MockClient([
        (c) => c.emit('agent_error', { message: 'no flag' }), // retryable missing
      ]);
      const prompts = new RecordingPrompts();

      await expectRejects(
        () => run({ prompt: 'go' }, prompts, client),
        ApiError,
      );
      expect(err.join('')).to.contain('no flag');
      // Did not loop back for more input.
      expect(prompts.calls).to.deep.equal([]);
    });

    it('prints the error and continues the loop when retryable', async function () {
      const client = new MockClient([
        (c) => c.emit('agent_error', { message: 'transient', retryable: true }),
      ]);
      // After the retryable error the loop asks for input again → blank → exit.
      const prompts = new RecordingPrompts({ line: [''] });

      await run({ prompt: 'go' }, prompts, client);

      expect(err.join('')).to.contain('transient');
      expect(client.closed).to.equal(true);
      // The loop solicited another turn rather than throwing.
      expect(prompts.calls).to.deep.equal([{ method: 'line', prompt: '> ' }]);
    });
  });

  describe('awaiting_input (MFA) loop', function () {
    it('feeds the reply via linePrivate and waits for the real terminal frame', async function () {
      const client = new MockClient([
        (c) => c.emit('awaiting_input', { reason: 'mfa' }),
        (c) => c.emit('end', { result: { success: true } }),
      ]);
      const prompts = new RecordingPrompts({
        linePrivate: ['123456'], // MFA code
        line: [''], // exit after the turn completes
      });

      await run({ prompt: 'run the task' }, prompts, client);

      // start(prompt) then send(code) — the code went over `send`, not a new turn.
      expect(client.sent).to.deep.equal([
        { type: 'start', text: buildFirstTurn('run the task') },
        { type: 'send', text: '123456' },
      ]);
      // The MFA code was collected through the history-disabled seam.
      expect(prompts.calls.some((c) => c.method === 'linePrivate')).to.equal(
        true,
      );
    });

    it('exits the chat when the user blanks the MFA prompt', async function () {
      const client = new MockClient([
        (c) => c.emit('awaiting_input', { reason: 'mfa' }),
      ]);
      const prompts = new RecordingPrompts({ linePrivate: [''] }); // blank → exit

      await run({ prompt: 'run the task' }, prompts, client);

      expect(client.sent).to.deep.equal([
        { type: 'start', text: buildFirstTurn('run the task') },
      ]);
      expect(client.closed).to.equal(true);
    });
  });

  it('sends login tasks without collecting credentials and prints a saved-profile tip', async function () {
    const client = new MockClient([
      (c) => c.emit('end', { result: { success: true } }),
    ]);
    const prompts = new RecordingPrompts();
    await run({ prompt: 'please log into example.com' }, prompts, client);
    expect(prompts.calls).to.deep.equal([{ method: 'line', prompt: '> ' }]);
    expect(out.join('')).to.contain('browserless agent --cloud-profile <name>');
    expect(client.sent[0].text).to.contain('Never ask the user for a password');
    expect(client.sent[0].text).to.not.match(/USERNAME=|PASSWORD=/);
  });

  describe('cloud profiles and first-turn instructions', function () {
    it('persists only typed tasks, not CLI instructions, and sends follow-ups raw', async function () {
      const persisted: string[] = [];
      class HistoryRecordingPrompts extends RecordingPrompts {
        async line(prompt: string): Promise<string> {
          const answer = await super.line(prompt);
          if (answer) persisted.push(answer); // what readline would record
          return answer;
        }
      }

      const client = new MockClient([
        (c) => c.emit('end', { result: { success: true } }),
        (c) => c.emit('end', { result: { success: true } }),
      ]);
      const prompts = new HistoryRecordingPrompts({
        line: ['please log into example.com', 'now open settings', ''],
      });

      // No opts.prompt → the first turn comes through `line()`, the history path.
      await run({}, prompts, client);

      expect(client.sent).to.deep.equal([
        { type: 'start', text: buildFirstTurn('please log into example.com') },
        { type: 'send', text: 'now open settings' },
      ]);
      expect(persisted).to.deep.equal([
        'please log into example.com',
        'now open settings',
      ]);
      expect(persisted.join('\n')).to.not.contain(
        'Instructions from the Browserless CLI',
      );
    });

    for (const cloudProfile of [undefined, 'work']) {
      it(`keeps JSON stdout clean and sends the first-turn instructions (profile=${cloudProfile})`, async function () {
        const client = new MockClient([
          (c) => c.emit('end', { result: { success: true } }),
        ]);
        const prompts = new RecordingPrompts();
        const deps = makeDeps(client);
        const getProfile = sandbox.spy(deps, 'getProfile');
        const makeClient = sandbox.spy(deps, 'makeClient');
        await runAgentChat(
          { prompt: 'log in to example.com', cloudProfile, json: true },
          prompts,
          deps,
        );
        expect(JSON.parse(out.join(''))).to.deep.equal({
          type: 'end',
          result: { success: true },
        });
        expect(client.sent[0].text).to.equal(
          buildFirstTurn('log in to example.com', { cloudProfile }),
        );
        expect(prompts.calls).to.deep.equal([{ method: 'line', prompt: '> ' }]);
        if (cloudProfile) {
          expect(getProfile.args).to.deep.equal([
            [
              { server: 'https://stub.test', token: 'tok', source: 'flag' },
              'work',
            ],
          ]);
          expect(getProfile.calledBefore(makeClient)).to.equal(true);
          expect(err.join('')).to.not.contain(LOGIN_TIP);
        } else {
          expect(getProfile.called).to.equal(false);
          expect(err.join('')).to.contain(LOGIN_TIP);
        }
      });
    }

    it('rejects malformed names before resolving credentials or making any connection', async function () {
      const deps = makeDeps(new MockClient());
      const buildClient = sandbox.spy(deps, 'buildClient');
      const getProfile = sandbox.spy(deps, 'getProfile');
      const makeClient = sandbox.spy(deps, 'makeClient');
      const error = await expectRejects(
        () =>
          runAgentChat({ cloudProfile: 'a b' }, new RecordingPrompts(), deps),
        UsageError,
      );
      expect(error.code).to.equal('invalid-cloud-profile-name');
      expect(error.exitCode).to.equal(2);
      expect(
        buildClient.called || getProfile.called || makeClient.called,
      ).to.equal(false);
    });

    for (const status of [404, 401, 0]) {
      it(`handles preflight status ${status} without opening a socket`, async function () {
        const deps = makeDeps(new MockClient());
        const original = new ApiError('preflight failed', status);
        deps.getProfile = async () => {
          throw original;
        };
        const makeClient = sandbox.spy(deps, 'makeClient');
        const execute = () =>
          runAgentChat({ cloudProfile: 'work' }, new RecordingPrompts(), deps);
        const error =
          status === 404
            ? await expectRejects(execute, UsageError)
            : await expectRejects(execute, ApiError);
        if (status === 404) {
          expect((error as UsageError).code).to.equal(
            'cloud-profile-not-found',
          );
          expect(error.exitCode).to.equal(2);
          expect(error.message).to.contain('browserless profile list');
        } else {
          expect(error).to.equal(original);
          expect(error.exitCode).to.equal(5);
        }
        expect(makeClient.called).to.equal(false);
      });
    }
  });

  describe('interrupt (SIGINT / SIGBREAK) lifecycle', function () {
    it('first Ctrl-C sends stop; second exits 130; handlers removed on completion', async function () {
      const exitStub = sandbox
        .stub(process, 'exit')
        .callsFake((() => {}) as never);
      const beforeInt = process.listenerCount('SIGINT');
      const beforeBrk = process.listenerCount('SIGBREAK');

      // A turn that never resolves on its own — we drive it via SIGINT, then
      // close the socket to let the REPL unwind.
      const client = new MockClient();
      const prompts = new RecordingPrompts();

      const done = run({ prompt: 'long task' }, prompts, client);
      // Let the body advance to `await waitForTurnEnd` (start already sent).
      await new Promise((r) => setImmediate(r));
      // Both interrupt signals are wired (SIGBREAK is the Windows Ctrl-Break path).
      expect(process.listenerCount('SIGINT')).to.equal(beforeInt + 1);
      expect(process.listenerCount('SIGBREAK')).to.equal(beforeBrk + 1);

      process.emit('SIGINT');
      expect(client.stopCount).to.equal(1);
      expect(err.join('')).to.contain('stop sent');
      expect(exitStub.called).to.equal(false);

      process.emit('SIGINT');
      expect(exitStub.calledWith(130)).to.equal(true);

      // Unwind: closing the socket resolves the pending turn → loop breaks.
      client.emit('close', { code: 1000, reason: '' });
      await done;

      // Both process-level handlers were uninstalled in `finally`.
      expect(process.listenerCount('SIGINT')).to.equal(beforeInt);
      expect(process.listenerCount('SIGBREAK')).to.equal(beforeBrk);
    });

    it('Ctrl-Break (SIGBREAK) drives the same double-tap as Ctrl-C', async function () {
      const exitStub = sandbox
        .stub(process, 'exit')
        .callsFake((() => {}) as never);
      const client = new MockClient();
      const prompts = new RecordingPrompts();

      const done = run({ prompt: 'long task' }, prompts, client);
      await new Promise((r) => setImmediate(r));

      // First SIGBREAK interrupts; a following SIGINT shares the counter → exit.
      process.emit('SIGBREAK');
      expect(client.stopCount).to.equal(1);
      expect(exitStub.called).to.equal(false);

      process.emit('SIGINT');
      expect(exitStub.calledWith(130)).to.equal(true);

      client.emit('close', { code: 1000, reason: '' });
      await done;
    });
  });
});
