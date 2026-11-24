// Tests for check-public-pr-text.mjs. Run with:
//   node --test scripts/ci/check-public-pr-text.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  commitMessages,
  findViolations,
  main,
} from './check-public-pr-text.mjs';

// Build ID-shaped strings at runtime so check-internal-references.sh, which
// scans every tracked file for them, does not flag these fixtures.
const id = (prefix, number) => `${prefix}-${number}`;

const run = (env, readCommits) => {
  const lines = [];
  const code = main(env, {
    readCommits: readCommits ?? (() => []),
    log: (line) => lines.push(line),
  });
  return { code, out: lines.join('\n') };
};

const cases = [
  [`fix: ${id('ABC', 1303)} rename`, [id('ABC', 1303)]],
  [`docs(${id('XYZ', 539)}): align`, [id('XYZ', 539)]],
  [`feat: add handoffs ${id('QA', 410)}`, [id('QA', 410)]],
  ['see https://linear.app/x/issue/1', ['linear.app']],
  ['thread https://ampcode.com/threads/T-1', ['ampcode.com/threads']],
  ['see https://AMPCODE.com/threads/T-2', ['AMPCODE.com/threads']],
  ['Co-authored-by: Amp <amp@ampcode.com>', []],
  ['https://acme.SLACK.com/archives/C1', ['SLACK.com']],
  ['session https://app.devin.ai/sessions/1', ['devin.ai']],
  ['https://app.usepylon.com/issues?issueNumber=1', ['usepylon.com']],
  [`fix: read ${id('UTF', 8)} text`, []],
  [
    `chore: ${id('SHA', 256)} and ${id('ISO', 8601)} and ${id('RFC', 6455)} and ${id('TLS', 1)} and ${id('HTTP', 2)}`,
    [],
  ],
  [`deps: patch ${id('CVE', 2025)}-12345`, []],
  [`fix: ${id('AES', 256)} and ${id('PEP', 8)} and ${id('ES', 2022)}`, []],
  [`see ${id('GHSA', 4)}xx-xxxx-xxxx and ${id('ECMA', 262)}`, []],
  ['call nonlinear.apply()', []],
  ['build(deps): bump ws from 8.22.2 to 8.23.0', []],
  ['Closes #12', []],
  [`fix: ${id('abc', 1301)} lowercase`, []],
  [`${id('A', 1)} single letter`, []],
  ['', []],
];

for (const [text, expected] of cases) {
  test(`findViolations(${JSON.stringify(text)})`, () => {
    assert.deepEqual(findViolations(text), expected);
  });
}

test('a clean pull request passes and prints nothing', () => {
  const { code, out } = run({
    PR_TITLE: 'docs: fix typo',
    PR_BODY: 'Closes #12',
  });
  assert.equal(code, 0);
  assert.equal(out, '');
});

test('a ticket ID in the title fails', () => {
  const { code, out } = run({ PR_TITLE: `fix: ${id('ABC', 12)} typo` });
  assert.equal(code, 1);
  assert.match(
    out,
    new RegExp(
      `::error::PR title contains internal references: ${id('ABC', 12)}`,
    ),
  );
});

test('an internal link in the body fails', () => {
  const { code, out } = run({
    PR_TITLE: 'docs: fix typo',
    PR_BODY: 'see https://x.slack.com/a',
  });
  assert.equal(code, 1);
  assert.match(out, /PR body contains internal references: slack\.com/);
});

test("the review bot's badge in the body passes", () => {
  const badge =
    '<a href="https://app.devin.ai/review/browserless/browserless-cli/pull/3" ' +
    'target="_blank"><picture><source media="(prefers-color-scheme: dark)" ' +
    'srcset="https://static.devin.ai/assets/gh-devin-review-dark.svg?v=4">' +
    '<img src="https://static.devin.ai/assets/gh-devin-review-light.svg?v=4" ' +
    'alt="Devin Review"></picture></a>';
  const { code, out } = run({ PR_TITLE: 'docs: fix typo', PR_BODY: badge });
  assert.equal(code, 0);
  assert.equal(out, '');
});

test('other links on the review bot host still fail', () => {
  const { code, out } = run({
    PR_TITLE: 'docs: fix typo',
    PR_BODY: 'see https://app.devin.ai/sessions/abc',
  });
  assert.equal(code, 1);
  assert.match(out, /PR body contains internal references: devin\.ai/);
});

for (const body of [
  'https://app.devin.ai/review/browserless/browserless-cli/pull/3?next=https://linear.app/x',
  'https://app.devin.ai/review/browserless/browserless-cli/pull/3/../../sessions/abc',
  `https://app.devin.ai/review/${id('ABC', 1303)}`,
  `https://static.devin.ai/assets/${id('ABC', 1303)}.svg`,
  // URL parsing turns a backslash into a path separator and drops tabs, and a
  // Markdown link in angle brackets may contain a space, so each of these
  // resolves to a page outside the review path.
  'https://app.devin.ai/review/browserless/browserless-cli/pull/3\\..\\..\\..\\..\\..\\sessions\\abc',
  '[review](<https://app.devin.ai/review/browserless/browserless-cli/pull/3 /../../../../../sessions/abc>)',
  'href="https://app.devin.ai/review/browserless/browserless-cli/pull/3\t/../../../../../sessions/abc"',
  'https://static.devin.ai/assets/gh-devin-review-dark.svg\\..\\..\\other.svg',
  // Outside a quoted HTML attribute, even the exact badge URL is not exempt.
  'https://app.devin.ai/review/browserless/browserless-cli/pull/3',
]) {
  test(`the badge exemption cannot hide other text: ${body}`, () => {
    assert.equal(run({ PR_TITLE: 'docs: fix typo', PR_BODY: body }).code, 1);
  });
}

test("Dependabot's body and commits are not checked", () => {
  let commitsRead = false;
  const { code, out } = run(
    {
      PR_TITLE: 'build(deps): bump ws',
      PR_BODY: `upstream ${id('ABC', 1234)} and https://x.slack.com/a`,
      PR_AUTHOR: 'dependabot[bot]',
      BASE_SHA: 'a'.repeat(40),
      HEAD_SHA: 'b'.repeat(40),
    },
    () => {
      commitsRead = true;
      return [];
    },
  );
  assert.equal(code, 0);
  assert.equal(out, '');
  assert.equal(commitsRead, false);
});

test("Dependabot's title is checked", () => {
  const { code } = run({
    PR_TITLE: `build(deps): bump X ${id('ABC', 1)}`,
    PR_AUTHOR: 'dependabot[bot]',
  });
  assert.equal(code, 1);
});

test('only the matches are echoed, never the untrusted text', () => {
  const { code, out } = run({ PR_TITLE: `$(touch pwned) ${id('ABC', 1)}` });
  assert.equal(code, 1);
  assert.doesNotMatch(out, /touch pwned/);
});

test('commit messages are checked and reported by position', () => {
  const { code, out } = run(
    {
      PR_TITLE: 'feat: ok',
      BASE_SHA: 'a'.repeat(40),
      HEAD_SHA: 'b'.repeat(40),
    },
    () => [
      'feat: ok\n\nCo-authored-by: Amp <amp@ampcode.com>',
      `fix: ${id('XYZ', 9)} bad`,
    ],
  );
  assert.equal(code, 1);
  assert.match(
    out,
    new RegExp(`PR commit 2 contains internal references: ${id('XYZ', 9)}`),
  );
  assert.doesNotMatch(out, /PR commit 1/);
});

test('commitMessages refuses anything that is not a commit SHA', () => {
  assert.throws(() => commitMessages('--output=x', 'HEAD'), /commit SHAs/);
  assert.throws(() => commitMessages('a'.repeat(40), 'main'), /commit SHAs/);
});

test('commitMessages reads the messages between two commits from git', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'public-pr-text-'));
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' },
    ).trim();
  try {
    git('init', '--quiet');
    git('commit', '--quiet', '--allow-empty', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('commit', '--quiet', '--allow-empty', '-m', 'feat: one');
    git('commit', '--quiet', '--allow-empty', '-m', 'fix: two');
    const head = git('rev-parse', 'HEAD');
    assert.deepEqual(commitMessages(base, head, dir), [
      'fix: two',
      'feat: one',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
