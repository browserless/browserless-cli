import { configFile } from './paths.js';
import { ConfigShape } from './schema.js';
import {
  readJsonFile,
  writeSecureJsonFile,
} from '../utils/json-file.js';

// `typeof [] === 'object'` is true, so reject arrays + null explicitly.
// A non-object payload is treated like an empty file (first-run recovery)
// — see the readConfig docstring for the rationale. This predicate runs
// *after* readJsonFile returns, not inside it: the readJsonFile validator
// is deliberately disabled (validate: () => true) so the throw path stays
// reserved for corrupt-JSON / EACCES errors, and we handle the
// non-object-payload case here with an inline `{}` fallback.
const isConfigShape = (parsed: unknown): parsed is ConfigShape =>
  !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);

/**
 * Read `~/.browserless/config.json` and return its contents.
 *
 * Missing file → `{}` (first-run flow writes into the empty shape).
 * Empty file or parsed-to-non-object → `{}` (the user has touched the
 * file but there's nothing to merge — same first-run behaviour). Corrupt
 * JSON or an unreadable file is a *real* error: returning `{}` here lets
 * the next `updateConfig` silently overwrite the file and destroy
 * whatever the user had. Surface those via `PreconditionError` so the
 * user can rescue the file.
 */
export const readConfig = async (): Promise<ConfigShape> => {
  const parsed = await readJsonFile<unknown>(configFile(), {
    defaults: {},
    validate: (_v): _v is unknown => true,
    errorCode: 'invalid-config-file',
  });
  if (!isConfigShape(parsed)) return {};
  return parsed;
};

/**
 * Atomically write the given config to disk with mode 0600. Creates
 * `~/.browserless/` with mode 0700 if missing. Uses a temp-file rename
 * so a crash mid-write can never leave a half-written config.json behind.
 */
export const writeConfig = (config: ConfigShape): Promise<void> =>
  writeSecureJsonFile(configFile(), config, { atomic: true });

/** Mutate one key in-place via a read → patch → write cycle. */
export const updateConfig = async (
  patch: (config: ConfigShape) => ConfigShape | void,
): Promise<ConfigShape> => {
  const current = await readConfig();
  const next = patch(current) ?? current;
  await writeConfig(next);
  return next;
};
