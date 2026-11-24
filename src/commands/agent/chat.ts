import type { EventEmitter } from 'node:events';
import { stdout as output, stderr } from 'node:process';
import { buildClient, printJson } from '../../cli-utils/client.js';
import { buildPrompts, type Prompts } from '../../cli-utils/prompts.js';
import { ApiError, UsageError } from '../../errors.js';
import { assertCloudProfileName, getProfile } from '../../api/profiles.js';
import { AgentClient, type AgentClientOptions } from '../../agent/ws-client.js';
import type { AgentEndFrame } from '../../agent/types.js';
import { loadHistory, saveHistory } from '../../agent/history.js';
import {
  normalizeRationale,
  formatEndResult,
  hasLoginIntent,
  summarizeParams,
  unwrapToolCall,
  buildFirstTurn,
  LOGIN_TIP,
} from '../../cli-utils/agent-format.js';
import { colorsFor } from '../../utils/ansi.js';
import { Spinner, type SpinnerPart } from '../../utils/spinner.js';
import { terminalSafe } from '../../utils/terminal.js';

export interface ChatOptions {
  prompt?: string;
  cloudProfile?: string;
  token?: string;
  server?: string;
  region?: string;
  json?: boolean;
  /**
   * Read + persist `~/.browserless/agent_history`. True by default; commander's
   * `--no-history` flag sets this to `false`.
   */
  history?: boolean;
}

/** The slice of `AgentClient` the REPL drives, so tests can inject a mock. */
export interface AgentClientLike extends EventEmitter {
  connect(): Promise<void>;
  start(prompt: string): void;
  send(prompt: string): void;
  stop(): void;
  close(): void;
}

/** Injectable construction seam — the production defaults hit the real network. */
export interface RunAgentChatDeps {
  buildClient: typeof buildClient;
  getProfile: typeof getProfile;
  makeClient: (init: AgentClientOptions) => AgentClientLike;
}

const defaultDeps: RunAgentChatDeps = {
  buildClient,
  getProfile,
  makeClient: (init) => new AgentClient(init),
};

/** The terminal `end` frame — typed by the wire-contract mirror. */
type EndPayload = AgentEndFrame;

/** A single turn's terminal signal. Returned by `waitForTurnEnd`. */
type TurnOutcome =
  | { kind: 'end'; payload: EndPayload }
  | { kind: 'awaiting_input'; payload: { reason?: string } }
  | {
      kind: 'error';
      payload: { code?: string; message?: string; retryable?: boolean };
    }
  | { kind: 'closed' };

/** Wait until the server emits a terminal frame for the current turn. */
const waitForTurnEnd = (client: AgentClientLike): Promise<TurnOutcome> =>
  new Promise((resolve) => {
    const cleanup = () => {
      client.off('end', onEnd);
      client.off('awaiting_input', onAwait);
      client.off('agent_error', onErr);
      client.off('close', onClose);
    };
    const onEnd = (payload: EndPayload) => {
      cleanup();
      resolve({ kind: 'end', payload });
    };
    const onAwait = (payload: { reason?: string }) => {
      cleanup();
      resolve({ kind: 'awaiting_input', payload });
    };
    const onErr = (payload: {
      code?: string;
      message?: string;
      retryable?: boolean;
    }) => {
      cleanup();
      resolve({ kind: 'error', payload });
    };
    const onClose = () => {
      cleanup();
      resolve({ kind: 'closed' });
    };
    client.once('end', onEnd);
    client.once('awaiting_input', onAwait);
    client.once('agent_error', onErr);
    client.once('close', onClose);
  });

/**
 * Tracks what's on the live row so each event can clear, append, or commit:
 * `data` deltas stream as `text`, `tool_call` switches to a `status` spinner
 * line, and `end` / `tool_result` return to `idle`.
 */
type RenderMode = 'idle' | 'status' | 'text';

interface Renderer {
  printEnd: (payload: EndPayload) => void;
  clearStatus: () => void;
  dispose: () => void;
}

/**
 * Subscribe live-status rendering to the agent client: tool progress collapses
 * onto one spinner line that updates in place, text deltas stream normally, and
 * non-TTY falls back to one scrolling line per completed tool.
 */
interface ToolMeta {
  rationale?: string;
  summary: string;
  method: string;
}

const createRenderer = (
  client: AgentClientLike,
  jsonMode: boolean,
): Renderer => {
  // In --json mode stdout is reserved for the final JSON payload
  const ui = jsonMode ? stderr : output;
  const c = colorsFor(ui);
  const spinner = new Spinner({ out: ui });
  const toolMeta = new Map<string, ToolMeta>();
  let mode: RenderMode = 'idle';

  const ensureTextStart = (): void => {
    if (mode === 'status') {
      spinner.clear();
      ui.write('\n');
    }
  };

  const ensureLineEndedBeforeBlock = (): void => {
    if (mode === 'text') ui.write('\n');
    if (mode === 'status') spinner.clear();
  };

  client.on('data', (frame: { text?: string }) => {
    if (typeof frame.text !== 'string' || frame.text.length === 0) return;
    ensureTextStart();
    mode = 'text';
    // Escape each delta independently so split frames cannot form controls.
    ui.write(
      terminalSafe(frame.text.replace(/\r$/, ''), { preserveLayout: true }),
    );
  });

  // Keep styles separate so the spinner can clip plain text without cutting ANSI resets.
  const formatLine = ({
    rationale,
    method,
    summary,
  }: ToolMeta): SpinnerPart[] => {
    const parts: SpinnerPart[] = [];
    if (rationale) parts.push({ text: `${rationale}: ` });
    if (method && method !== 'commands') {
      parts.push({ text: method, style: c.gray });
      if (summary) parts.push({ text: ' ' });
    }
    if (summary) parts.push({ text: summary, style: c.dim });
    return parts;
  };

  client.on(
    'tool_call',
    (frame: {
      id?: string;
      method?: unknown;
      params?: unknown;
      rationale?: unknown;
    }) => {
      if (mode === 'text') ui.write('\n');
      // The connector reports the MCP tool name + full args; unwrap to the
      // inner BQL method + display params so the line reads `goto url=…`.
      const { method, params } = unwrapToolCall(frame.method, frame.params);
      const rationale = normalizeRationale(frame.rationale);
      const meta = {
        rationale: rationale ? terminalSafe(rationale) : undefined,
        summary: terminalSafe(summarizeParams(params)),
        method: terminalSafe(method),
      };
      toolMeta.set(frame.id ?? '', meta);
      mode = 'status';
      // Spinner draws its own braille frame at the front; we provide the rest.
      spinner.set(formatLine(meta));
    },
  );

  client.on('tool_result', (frame: { id?: string; ok?: boolean }) => {
    // tool_result carries only {id, method, ok}; reuse the cached meta from
    // the tool_call, or show an unknown tool when no matching call remains.
    const meta = toolMeta.get(frame.id ?? '') ?? { method: '?', summary: '' };
    toolMeta.delete(frame.id ?? '');
    if (mode === 'text') ui.write('\n');
    spinner.done([
      { text: frame.ok ? '✓' : '✗', style: frame.ok ? c.green : c.red },
      { text: ' ' },
      ...formatLine(meta),
    ]);
    // `spinner.done` commits the line with a trailing newline, so the cursor
    // is already on a fresh row — back to `idle`. Subsequent events
    // (next tool_call, data, end) start cleanly without extra clears.
    mode = 'idle';
  });

  // `usage` frames arrive for server-side billing but we don't surface token
  // chrome in the REPL. Subscribe to a no-op so the frame isn't left unhandled
  // on the EventEmitter.
  client.on('usage', () => {});

  return {
    printEnd: (payload) => {
      ensureLineEndedBeforeBlock();
      mode = 'idle';
      if (jsonMode) {
        printJson({ type: 'end', result: payload.result ?? null });
        return;
      }
      const pretty = formatEndResult(payload);
      ui.write(pretty ? `\n${pretty}\n` : '\n');
    },
    clearStatus: () => {
      ensureLineEndedBeforeBlock();
      mode = 'idle';
    },
    dispose: () => spinner.clear(),
  };
};

const installSigint = (
  client: AgentClientLike,
  clearStatus: () => void,
): (() => void) => {
  let count = 0;
  const handler = () => {
    count += 1;
    if (count === 1) {
      clearStatus();
      process.stderr.write(
        colorsFor(process.stderr).gray(
          '\n(stop sent — press Ctrl-C again to exit)\n',
        ),
      );
      try {
        client.stop();
      } catch {
        /* socket already closed */
      }
    } else {
      process.exit(130);
    }
  };
  // SIGBREAK (Windows Ctrl-Break) shares SIGINT's double-tap: readline can swallow SIGINT mid-prompt on Windows, but Ctrl-Break is always delivered. No-op on POSIX. Peer: profile/launch.ts.
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGBREAK'];
  signals.forEach((sig) => process.on(sig, handler));
  return () => signals.forEach((sig) => process.off(sig, handler));
};

/**
 * Top-level action for the `agent` command. Drives the REPL until the user
 * exits (blank line, EOF, Ctrl-C twice) or the server closes. The `prompts`
 * seam lets tests inject deterministic input without a TTY.
 */
export const runAgentChat = async (
  opts: ChatOptions,
  promptsOverride?: Prompts,
  deps: RunAgentChatDeps = defaultDeps,
): Promise<void> => {
  if (opts.cloudProfile !== undefined)
    assertCloudProfileName(opts.cloudProfile);
  const jsonMode = !!opts.json;
  const client = await deps.buildClient(opts);
  // stdout is JSON-only in --json mode; the banner is human UI → stderr.
  const ui = jsonMode ? stderr : output;
  ui.write(
    colorsFor(ui).dim(
      `agent → ${client.server} (token from ${client.source})\n`,
    ),
  );

  if (opts.cloudProfile) {
    try {
      await deps.getProfile(client, opts.cloudProfile);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new UsageError(
          `Cloud profile "${terminalSafe(opts.cloudProfile)}" was not found for this token. Use the name you passed to --name when you ran \`browserless profile upload\`; run \`browserless profile list\` to see your profiles.`,
          'cloud-profile-not-found',
        );
      }
      throw error;
    }
  }

  // History: best-effort. A read or write failure must not block the chat —
  // we degrade to in-memory only and keep going. Commander's `--no-history`
  // sets `opts.history = false`; default-undefined means enabled.
  const historyEnabled = opts.history !== false && !promptsOverride;
  const history = historyEnabled ? await loadHistory().catch(() => []) : [];
  const persist = historyEnabled
    ? (entries: string[]) => saveHistory(entries)
    : async () => undefined;
  const prompts = promptsOverride ?? buildPrompts(history, persist, ui);

  const ws = deps.makeClient({
    server: client.server,
    token: client.token,
  });
  await ws.connect();
  const renderer = createRenderer(ws, jsonMode);
  const uninstallSigint = installSigint(ws, renderer.clearStatus);

  try {
    let firstTurn = true;
    while (true) {
      let userText: string;
      if (firstTurn && opts.prompt) {
        userText = opts.prompt;
      } else {
        try {
          userText = await prompts.line('> ');
        } catch {
          break;
        }
        if (userText === '') {
          if (firstTurn) continue;
          break;
        }
      }

      if (firstTurn && !opts.cloudProfile && hasLoginIntent(userText)) {
        ui.write(`${LOGIN_TIP}\n`);
      }

      if (firstTurn)
        ws.start(buildFirstTurn(userText, { cloudProfile: opts.cloudProfile }));
      else ws.send(userText);
      firstTurn = false;

      let outcome = await waitForTurnEnd(ws);
      // The agent paused for the user (e.g. MFA). Stay in the same session,
      // collect the reply, send it, and wait for the actual terminal frame.
      while (outcome.kind === 'awaiting_input') {
        const reply = await prompts.linePrivate('Enter code: ');
        if (!reply) {
          // No reply → exit the chat. Synthesize `closed` so the outer narrowing
          // sees a non-awaiting outcome and TS doesn't keep `awaiting_input` in
          // the union for `printEnd` below.
          outcome = { kind: 'closed' };
          break;
        }
        ws.send(reply);
        outcome = await waitForTurnEnd(ws);
      }
      if (outcome.kind === 'closed') break;
      if (outcome.kind === 'error') {
        renderer.clearStatus();
        process.stderr.write(
          `error: ${terminalSafe(outcome.payload.message || outcome.payload.code || 'unknown', { preserveLayout: true }).replaceAll('\n', '\n       ')}\n`,
        );
        if (outcome.payload.retryable !== true) {
          throw new ApiError(
            'Agent session ended with an error.',
            0,
            undefined,
            'agent-session-error',
          );
        }
        continue;
      }
      renderer.printEnd(outcome.payload);
    }
  } finally {
    uninstallSigint();
    renderer.dispose();
    ws.close();
  }
};
