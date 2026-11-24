import { expect } from 'chai';
import { PassThrough, Writable } from 'node:stream';
import { buildPrompts } from './prompts.js';

/** Writable that records every `write()` so prompt chrome can be asserted. */
const collectingWritable = () => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
};

const noopPersist = async () => undefined;

describe('cli-utils/prompts', function () {
  describe('line / linePrivate (readline)', function () {
    it('linePrivate resolves the trimmed line from the input stream', async function () {
      const inp = new PassThrough();
      const out = collectingWritable();
      const prompts = buildPrompts(
        [],
        noopPersist,
        out.stream as unknown as NodeJS.WriteStream,
        inp as unknown as NodeJS.ReadStream,
      );
      const pending = prompts.linePrivate('Enter code: ');
      inp.write('  123456  \n');

      expect(await pending).to.equal('123456');
    });

    it('line resolves the trimmed answer and persists best-effort', async function () {
      const inp = new PassThrough();
      const out = collectingWritable();
      const persisted: string[][] = [];
      const prompts = buildPrompts(
        [],
        async (entries) => {
          persisted.push([...entries]);
        },
        out.stream as unknown as NodeJS.WriteStream,
        inp as unknown as NodeJS.ReadStream,
      );
      const pending = prompts.line('> ');
      inp.write('  do a thing  \n');

      expect(await pending).to.equal('do a thing');
      // persist is fire-and-forget (not awaited) — let the microtask run.
      // (History population itself only happens in terminal mode, so we assert
      // the persist hook fired, not its contents.)
      await new Promise((r) => setImmediate(r));
      expect(persisted).to.have.lengthOf(1);
    });
  });
});
