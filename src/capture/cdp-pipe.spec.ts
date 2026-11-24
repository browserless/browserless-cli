import { expect } from 'chai';
import { PassThrough } from 'node:stream';
import { connectCdpPipe, CDP_PIPE_CLOSED } from './cdp-pipe.js';
import { expectRejects } from '../test-helpers/assertions.js';

interface SentMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/**
 * Stands in for Chrome's end of `--remote-debugging-pipe`: `toBrowser` is
 * what the CLI writes (Chrome's fd 3), `fromBrowser` is what Chrome writes
 * back (fd 4). Messages are JSON, each terminated by a NUL byte.
 */
const fakeBrowser = () => {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const sent: SentMessage[] = [];
  let partial = '';
  toBrowser.on('data', (chunk: Buffer) => {
    partial += chunk.toString('utf8');
    const frames = partial.split('\0');
    partial = frames.pop() ?? '';
    for (const frame of frames) sent.push(JSON.parse(frame) as SentMessage);
  });
  const reply = (message: unknown) =>
    fromBrowser.write(`${JSON.stringify(message)}\0`);
  return { toBrowser, fromBrowser, sent, reply };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('capture/cdp-pipe.connectCdpPipe', () => {
  it('frames each command as NUL-terminated JSON and resolves with its result', async () => {
    const browser = fakeBrowser();
    const cdp = connectCdpPipe(browser.toBrowser, browser.fromBrowser);

    const pending = cdp.send('Browser.getVersion');
    await tick();
    expect(browser.sent).to.deep.equal([
      { id: 1, method: 'Browser.getVersion', params: {} },
    ]);

    browser.reply({ id: 1, result: { product: 'Chrome/140' } });
    expect(await pending).to.deep.equal({ product: 'Chrome/140' });
    cdp.close();
  });

  it('reassembles responses split across chunks and several in one chunk', async () => {
    const browser = fakeBrowser();
    const cdp = connectCdpPipe(browser.toBrowser, browser.fromBrowser);
    const first = cdp.send('A.one');
    const second = cdp.send('A.two');
    await tick();

    const wire = Buffer.from(
      `${JSON.stringify({ id: 1, result: { n: 'é1' } })}\0${JSON.stringify({ id: 2, result: { n: 2 } })}\0`,
    );
    // Split inside the multi-byte "é" to prove bytes, not strings, are joined.
    const cut = wire.indexOf(Buffer.from('é')) + 1;
    browser.fromBrowser.write(wire.subarray(0, cut));
    browser.fromBrowser.write(wire.subarray(cut));

    expect(await first).to.deep.equal({ n: 'é1' });
    expect(await second).to.deep.equal({ n: 2 });
    cdp.close();
  });

  it('rejects a command the browser answers with an error', async () => {
    const browser = fakeBrowser();
    const cdp = connectCdpPipe(browser.toBrowser, browser.fromBrowser);
    const pending = cdp.send('Target.closeTarget', { targetId: 'x' });
    await tick();

    browser.reply({ id: 1, error: { code: -32000, message: 'No target' } });

    await expectRejects(() => pending, Error, /Target\.closeTarget.*No target/);
    cdp.close();
  });

  it('routes commands and events through a flattened target session', async () => {
    const browser = fakeBrowser();
    const cdp = connectCdpPipe(browser.toBrowser, browser.fromBrowser);
    const tab = cdp.session('S1');
    const tabEvents: unknown[] = [];
    const browserEvents: unknown[] = [];
    tab.on('Fetch.requestPaused', (p) => tabEvents.push(p));
    cdp.on('Fetch.requestPaused', (p) => browserEvents.push(p));

    const pending = tab.send('Page.navigate', { url: 'https://a.test/' });
    await tick();
    expect(browser.sent[0]).to.deep.equal({
      id: 1,
      method: 'Page.navigate',
      params: { url: 'https://a.test/' },
      sessionId: 'S1',
    });

    browser.reply({
      method: 'Fetch.requestPaused',
      params: { requestId: 'r1' },
      sessionId: 'S1',
    });
    browser.reply({
      method: 'Fetch.requestPaused',
      params: { requestId: 'r2' },
      sessionId: 'S2',
    });
    browser.reply({ id: 1, result: {}, sessionId: 'S1' });
    await pending;

    expect(tabEvents).to.deep.equal([{ requestId: 'r1' }]);
    expect(browserEvents, 'session events never reach the browser level').to.be
      .empty;
    cdp.close();
  });

  it('once() resolves on the next event and the returned off() unsubscribes', async () => {
    const browser = fakeBrowser();
    const cdp = connectCdpPipe(browser.toBrowser, browser.fromBrowser);
    const tab = cdp.session('S1');
    const seen: unknown[] = [];
    const off = tab.on('Page.frameNavigated', (p) => seen.push(p));
    const loaded = tab.once('Page.loadEventFired');

    browser.reply({
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
      sessionId: 'S1',
    });
    expect(await loaded).to.deep.equal({ timestamp: 1 });

    off();
    browser.reply({
      method: 'Page.frameNavigated',
      params: {},
      sessionId: 'S1',
    });
    await tick();
    expect(seen).to.be.empty;
    cdp.close();
  });

  it('fails pending and later commands once the browser closes its end', async () => {
    const browser = fakeBrowser();
    const cdp = connectCdpPipe(browser.toBrowser, browser.fromBrowser);
    const pending = cdp.send('Storage.getCookies');
    const loaded = cdp.session('S1').once('Page.loadEventFired');
    await tick();

    browser.fromBrowser.end();

    await expectRejects(() => pending, Error, CDP_PIPE_CLOSED);
    await expectRejects(() => loaded, Error, CDP_PIPE_CLOSED);
    await expectRejects(
      () => cdp.send('Target.getTargets'),
      Error,
      CDP_PIPE_CLOSED,
    );
  });
});
