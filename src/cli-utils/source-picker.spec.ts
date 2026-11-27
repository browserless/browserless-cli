import { expect } from 'chai';
import sinon from 'sinon';
import type { DetectedProfile } from '../browsers/discover.js';
import { UsageError } from '../errors.js';
import { pickSourceProfile } from './source-picker.js';

const profile = (key: string, name: string): DetectedProfile => ({
  browserKey: key,
  browserDisplayName: key,
  profileDirName: 'Default',
  profileDisplayName: name,
  userDataDir: '/fake/user-data',
  profilePath: '/fake/user-data/Default',
  binaryPath: '/fake/browser',
});
const a = profile('picker-a', 'Picker A');
const b = profile('picker-b', 'Picker B');

describe('pickSourceProfile', () => {
  it('announces the only candidate without asking', async () => {
    const prompt = sinon.stub().rejects();
    const lines: string[] = [];
    expect(
      await pickSourceProfile([a], { prompt, write: (s) => lines.push(s) }),
    ).to.equal(a);
    expect(lines).to.deep.equal(['> Using picker-a / Picker A (Default)']);
    sinon.assert.notCalled(prompt);
  });

  it('lists names without paths or raw controls and accepts the selected number', async () => {
    const hostile = profile('picker-b', 'Evil\x1b[31mName');
    const lines: string[] = [];
    expect(
      await pickSourceProfile([a, hostile], {
        prompt: async (question) => {
          expect(question).to.equal('Enter a number [1-2]: ');
          return ' 2 ';
        },
        write: (s) => lines.push(s),
      }),
    ).to.equal(hostile);
    expect(lines).to.deep.equal([
      'Which browser profile should be captured?',
      '  1) picker-a / Picker A (Default)',
      '  2) picker-b / Evil\\u001b[31mName (Default)',
    ]);
  });

  it('allows a valid choice after two invalid answers', async () => {
    const answers = ['abc', '0', '1'];
    const lines: string[] = [];
    expect(
      await pickSourceProfile([a, b], {
        prompt: async () => answers.shift()!,
        write: (s) => lines.push(s),
      }),
    ).to.equal(a);
    expect(lines.slice(3)).to.deep.equal(
      Array(2).fill('Enter a number from 1 to 2.'),
    );
  });

  for (const answers of [['3', '1.5', ''], []]) {
    it(`rejects ${answers.length ? 'three invalid answers' : 'a closed prompt'}`, async () => {
      const prompt = sinon.stub().rejects();
      answers.forEach((answer, n) => prompt.onCall(n).resolves(answer));
      const error = await pickSourceProfile([a, b], {
        prompt,
        write: () => {},
      }).catch((err: unknown) => err);
      expect(error)
        .to.be.instanceOf(UsageError)
        .with.property('code', 'invalid-source-choice');
      expect(prompt.callCount).to.equal(answers.length || 1);
    });
  }
});
