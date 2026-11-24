import { green, red } from '../utils/ansi.js';
import { type AgentEndFrame, isAgentEndResult } from '../agent/types.js';
import { terminalSafe } from '../utils/terminal.js';

/**
 * Pure render/intent helpers for the `agent` REPL. Kept separate from the
 * action handler so they can be unit-tested without a TTY or a WebSocket.
 */

// Triggers the `--cloud-profile` tip; a false positive only prints a tip.
const LOGIN_INTENT_RE =
  /\b(log[- _]?in|sign[- _]?in|sign[- _]?up|authenticate|log on)/i;

export const hasLoginIntent = (text: string): boolean =>
  LOGIN_INTENT_RE.test(text);

/**
 * Normalize a model-supplied rationale: trim, and drop blank-only values to
 * `undefined`. No length cap — mid-word truncation reads as a UI bug, so the
 * model is asked to keep it short via the schema description instead.
 */
export const normalizeRationale = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
};

export const LOGIN_TIP =
  "Tip: the agent can't sign in for you. Save a signed-in browser with " +
  '`browserless profile upload --name <name> --browser <browser> --profile <local-profile>`, then rerun with ' +
  '`browserless agent --cloud-profile <name>`.';

export const buildFirstTurn = (
  task: string,
  opts: { cloudProfile?: string } = {},
): string => {
  const profile = JSON.stringify(opts.cloudProfile);
  const refreshHint =
    opts.cloudProfile && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.cloudProfile)
      ? `\`browserless profile refresh --name ${opts.cloudProfile}\``
      : '`browserless profile refresh --name <name>`, quoting the profile name for their shell';
  return [
    'Instructions from the Browserless CLI (not typed by the user):',
    ...(opts.cloudProfile
      ? [
          `- Open every new browser session with the user's saved cloud profile ${profile}: pass "profile": ${profile} to browserless_agent whenever you start a session without a sessionId. Keep reusing that session's sessionId afterwards.`,
          `- Never ask the user for a password, API key, or other secret, and never ask them to type one into this chat. If a site still asks you to sign in, stop and say the saved profile is not signed in there; the user can update it with ${refreshHint}.`,
        ]
      : [
          '- Never ask the user for a password, API key, or other secret, and never ask them to type one into this chat. If a site requires signing in, stop and say sign-in is needed; the user can save a signed-in browser with `browserless profile upload --name <name> --browser <browser> --profile <local-profile>` and rerun with `browserless agent --cloud-profile <name>`.',
        ]),
    '- You may still ask the user for a one-time verification code that a site sends during sign-in.',
    '',
    'User task:',
    task,
  ].join('\n');
};

/** Truncate a value so the inline params summary stays one line. */
const previewValue = (v: unknown, max: number): string => {
  const s =
    typeof v === 'string'
      ? v
      : v === null || typeof v !== 'object'
        ? String(v)
        : JSON.stringify(v);
  const points = [...s];
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : s;
};

const SENSITIVE_PARAM_KEY_RE =
  /^(pass(word|code)?|secret|token|auth(orization)?|cookie|credentials?|api[-_]?key|otp|mfa|text|value)$/i;

/**
 * One-line summary of a tool_call's params: the most useful first 1-2 keys,
 * trimmed. Falls back to a count when nothing renders cleanly.
 */
export const summarizeParams = (params: unknown, max = 60): string => {
  if (!params || typeof params !== 'object') return '';
  const obj = params as Record<string, unknown>;
  // For batched commands, prefer a method list over field-by-field dump.
  if (Array.isArray((obj as { commands?: unknown }).commands)) {
    const commands = (obj as { commands: unknown[] }).commands;
    const summary = `${commands.length} cmds: ${commands
      .map((c) =>
        c &&
        typeof c === 'object' &&
        'method' in c &&
        typeof c.method === 'string'
          ? c.method
          : '?',
      )
      .join(' → ')}`;
    return [...summary].slice(0, max).join('');
  }
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  const parts: string[] = [];
  let used = 0;
  for (const [k, v] of entries) {
    const value = SENSITIVE_PARAM_KEY_RE.test(k)
      ? '[REDACTED]'
      : previewValue(v, 30);
    const chunk = `${k}=${value}`;
    const length = [...chunk].length;
    if (used + length + 2 > max) break;
    parts.push(chunk);
    used += length + 2;
  }
  return parts.join(' ');
};

/**
 * Unwrap an MCP tool-call envelope into the display `{method, params}` the
 * spinner renders — connector frames carry the MCP tool name + full args, not
 * the inner BQL method the server used to pre-unwrap. Keeps the line `goto url=…`.
 */
export const unwrapToolCall = (
  name: unknown,
  params: unknown,
): { method: string; params: unknown } => {
  const args =
    params && typeof params === 'object'
      ? (params as Record<string, unknown>)
      : {};
  if (name === 'browserless_skill') {
    return { method: 'skill', params: { id: args.id } };
  }
  if (name === 'browserless_agent') {
    const commands = (args as { commands?: unknown }).commands;
    if (Array.isArray(commands) && commands.length > 0) {
      return { method: 'commands', params: { commands } };
    }
    return {
      method: typeof args.method === 'string' ? args.method : 'agent',
      params: args.params,
    };
  }
  return { method: typeof name === 'string' ? name : '?', params };
};

/** Pretty-print the `end` payload's structured result for the terminal. */
export const formatEndResult = (
  frame: Pick<AgentEndFrame, 'result'>,
): string => {
  // The wire is untyped JSON — guard structurally before trusting the shape.
  if (!isAgentEndResult(frame.result)) return '';
  const r = frame.result;
  const lines = [`Result: ${r.success ? green('success') : red('failed')}`];
  for (const key of ['reason_code', 'final_url', 'evidence'] as const) {
    if (typeof r[key] === 'string') {
      const label = `  ${key}: `;
      lines.push(
        label +
          terminalSafe(r[key], {
            preserveLayout: key === 'evidence',
          }).replaceAll('\n', `\n${' '.repeat(label.length)}`),
      );
    }
  }
  return lines.join('\n');
};
