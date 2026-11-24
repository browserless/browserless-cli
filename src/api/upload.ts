import { apiFetch, ClientOptions } from './client.js';
import { ApiError } from '../errors.js';
import { version } from '../version.js';
import { ProfileAuthState, ProfileCaptureSettings } from '../capture/types.js';

export interface ProfileResponse {
  id: string;
  name: string;
  /** What the profile was captured with, or null for a non-CLI creator. */
  captureSettings?: ProfileCaptureSettings | null;
  cookieCount: number;
  originCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadParams {
  name: string;
  attemptId?: string;
  state: ProfileAuthState;
  /** Optional pre-serialized state — saves a JSON.stringify pass. */
  serialized?: string;
  /**
   * Rejected wholesale by a server that predates the key — see AGENTS.md
   * "Mirrored types".
   */
  captureSettings?: ProfileCaptureSettings;
}

/**
 * Build the wire body for `/profile/upload` and `/profile/refresh`. If a
 * pre-serialized state is provided, splice it in directly instead of
 * round-tripping through `JSON.stringify` again — the artifact can be
 * up to 2 MB and the second stringify is the slowest step on hot paths.
 */
export const buildProfileBody = (params: UploadParams): string => {
  const state = params.serialized ?? JSON.stringify(params.state);
  const settings =
    params.captureSettings === undefined
      ? ''
      : `,"captureSettings":${JSON.stringify(params.captureSettings)}`;

  return `{"name":${JSON.stringify(params.name)},"state":${state}${settings}}`;
};

/**
 * ajv rejects an unknown body key before the handler runs, with a generic
 * `must NOT have additional properties` that names neither the field nor the
 * cause. Two skews produce it: a server with no `captureSettings` at all, and one
 * that has it but predates a member this CLI sends. Both are fixed by deploying
 * the server — never by retrying without the key, which is the silent degrade
 * AGENTS.md forbids — so the message says that and keeps the server's own text.
 */
export const rethrowCaptureSettingsSkew = (
  err: unknown,
  server: string,
): never => {
  if (
    !(err instanceof ApiError) ||
    err.status !== 400 ||
    !/additional propert/i.test(`${err.body ?? ''} ${err.message}`)
  ) {
    throw err;
  }
  throw new ApiError(
    `The server at ${server} rejected the profile capture settings this CLI (v${version}) sends — it predates either the field itself or one of its members. Deploy the server to every region before using this CLI against it. Server said: ${err.message}`,
    400,
    err.body,
    'capture-settings-rejected',
  );
};

/**
 * POST /profile/upload — strict create. 400 if name already exists for
 * this token, 400 if the artifact exceeds the 2 MB cap.
 */
export const uploadProfile = async (
  client: ClientOptions,
  params: UploadParams,
): Promise<ProfileResponse> => {
  try {
    return await apiFetch<ProfileResponse>(client, {
      method: 'POST',
      path: '/profile/upload',
      rawBody: buildProfileBody(params),
      attemptId: params.attemptId,
    });
  } catch (err) {
    return rethrowCaptureSettingsSkew(err, client.server);
  }
};
