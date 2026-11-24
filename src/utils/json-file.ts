import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PreconditionCode,
  PreconditionError,
} from '../errors.js';

/**
 * Shared secure read/write helpers for the CLI's `~/.browserless/` files. A
 * missing file returns the caller's empty shape; a corrupt one throws rather
 * than defaulting — a silent default would let the next write clobber it.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface ReadJsonFileOptions<T> {
  defaults: T;
  /**
   * Shape predicate. Falsy payloads (`null`, primitives) are also passed
   * in as `unknown` — handle them here, not in a separate type guard.
   */
  validate: (parsed: unknown) => parsed is T;
  /**
   * Attached to thrown errors so callers can dispatch on cause
   * programmatically instead of grepping `.message`.
   */
  errorCode: PreconditionCode;
  shapeHint?: string;
}

export const readJsonFile = async <T>(
  file: string,
  opts: ReadJsonFileOptions<T>,
): Promise<T> => {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return opts.defaults;
    throw new PreconditionError(
      `Failed to read ${file} (${code ?? 'unknown error'}): ${(err as Error).message}`,
      opts.errorCode,
    );
  }
  // Treat whitespace-only files like ENOENT — the user has touched the
  // file but there's nothing to merge.
  if (raw.trim() === '') return opts.defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PreconditionError(
      `Failed to parse ${file} — the file is not valid JSON. ` +
        `Inspect or remove it and retry. (${(err as Error).message})`,
      opts.errorCode,
    );
  }
  if (!opts.validate(parsed)) {
    const hint = opts.shapeHint ?? 'the expected JSON shape';
    throw new PreconditionError(
      `${file} does not match ${hint}. Inspect and fix the file.`,
      opts.errorCode,
    );
  }
  return parsed;
};

export interface WriteSecureFileOptions {
  /**
   * Write to a temp file then atomically rename it over the target, so a crash
   * mid-write can't leave a half-written file. Default `false` (one-shot write);
   * set `true` where a partial write would be data-loss.
   */
  atomic?: boolean;
}

/**
 * Write `payload` to `file` under the secure-write rules (dir 0700, file 0600,
 * optional atomic temp-rename) — the single audited place those rules live.
 * Use `writeSecureJsonFile` for JSON payloads.
 */
export const writeSecureFile = async (
  file: string,
  payload: string,
  opts: WriteSecureFileOptions = {},
): Promise<void> => {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dir, DIR_MODE).catch(() => undefined);

  if (opts.atomic) {
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, payload, { mode: FILE_MODE });
    await fs.rename(tmp, file);
    await fs.chmod(file, FILE_MODE).catch(() => undefined);
    return;
  }

  await fs.writeFile(file, payload, { mode: FILE_MODE });
  // fs.writeFile's `mode` only applies to a newly-created file — overwriting an
  // existing one leaves its mode untouched. Re-assert 0600 so the secure-write
  // invariant holds even if the file pre-existed with looser permissions.
  await fs.chmod(file, FILE_MODE).catch(() => undefined);
};

export type WriteSecureJsonFileOptions = WriteSecureFileOptions;

export const writeSecureJsonFile = (
  file: string,
  data: unknown,
  opts: WriteSecureJsonFileOptions = {},
): Promise<void> => writeSecureFile(file, JSON.stringify(data, null, 2), opts);
