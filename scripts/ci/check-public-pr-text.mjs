#!/usr/bin/env node
/**
 * Fail a pull request whose title, description or commit messages contain an
 * internal issue-tracker ID or a link to an internal tool. The title becomes a
 * public changelog entry, and the description and commit messages are public
 * on the pull request page.
 *
 * Reads PR_TITLE, PR_BODY, PR_AUTHOR, BASE_SHA and HEAD_SHA from the
 * environment; .github/workflows/public-pr-rules.yml sets them.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Public identifier schemes that have the same shape as tracker IDs.
const ALLOWED_PREFIXES = new Set([
  'UTF',
  'SHA',
  'ISO',
  'CVE',
  'GHSA',
  'RFC',
  'TLS',
  'HTTP',
  'AES',
  'PEP',
  'ECMA',
  'ES',
]);
const TICKET_ID = /\b([A-Z]{2,})-\d+/g;
// Only coding-agent thread links are blocked; the agent's Co-authored-by
// trailer is allowed.
const INTERNAL_HOST =
  /linear\.app\b|ampcode\.com\/threads|slack\.com|devin\.ai|usepylon\.com/gi;
// A review bot can add a badge to every PR description. Only the badge's exact
// review link and image URLs are exempt: anything else on that host still
// fails, and nothing may follow them (no query string or extra path).
const PUBLIC_BOT_LINK =
  /https:\/\/app\.devin\.ai\/review\/browserless\/browserless-cli\/pull\/\d+(?![\w/.?#&=%-])|https:\/\/static\.devin\.ai\/assets\/gh-devin-review-(?:dark|light)\.svg(?:\?v=\d+)?(?![\w/.?#&=%-])/g;
// Dependabot writes descriptions from upstream release notes, which can
// legitimately mention other projects' tracker IDs.
const TITLE_ONLY_AUTHORS = new Set(['dependabot[bot]']);
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

export const findViolations = (text) => {
  const scrubbed = text.replace(PUBLIC_BOT_LINK, '');
  const tickets = [...scrubbed.matchAll(TICKET_ID)]
    .filter((match) => !ALLOWED_PREFIXES.has(match[1]))
    .map((match) => match[0]);
  const hosts = [...scrubbed.matchAll(INTERNAL_HOST)].map((match) => match[0]);
  return [...tickets, ...hosts];
};

export const commitMessages = (base, head, cwd = process.cwd()) => {
  // Both ends come from the event payload; refuse anything else so a value
  // can never reach git as an option.
  if (!COMMIT_SHA.test(base) || !COMMIT_SHA.test(head)) {
    throw new Error('BASE_SHA and HEAD_SHA must be commit SHAs');
  }
  return execFileSync('git', ['log', '--format=%B%x00', `${base}..${head}`], {
    cwd,
    encoding: 'utf8',
  })
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean);
};

export const main = (
  env = process.env,
  { readCommits = commitMessages, log = console.log } = {},
) => {
  const checkAll = !TITLE_ONLY_AUTHORS.has(env.PR_AUTHOR ?? '');
  const base = env.BASE_SHA ?? '';
  const head = env.HEAD_SHA ?? '';
  const fields = [
    ['title', env.PR_TITLE ?? ''],
    ...(checkAll ? [['body', env.PR_BODY ?? '']] : []),
    ...(checkAll && base && head
      ? readCommits(base, head).map((message, index) => [
          `commit ${index + 1}`,
          message,
        ])
      : []),
  ];
  const failures = fields
    .map(([name, text]) => [name, findViolations(text)])
    .filter(([, violations]) => violations.length > 0);
  // Print only the matches: the text itself is untrusted and could inject
  // workflow commands.
  failures.forEach(([name, violations]) =>
    log(
      `::error::PR ${name} contains internal references: ${[...new Set(violations)].sort().join(', ')}`,
    ),
  );
  return failures.length > 0 ? 1 : 0;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
