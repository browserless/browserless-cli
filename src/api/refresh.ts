import { apiFetch, ClientOptions } from './client.js';
import {
  buildProfileBody,
  ProfileResponse,
  rethrowCaptureSettingsSkew,
  UploadParams,
} from './upload.js';

export type RefreshParams = UploadParams;

/**
 * POST /profile/refresh — strict replace. 404 if no profile by that name
 * exists for this token. Reuses the existing profile id and storage_key
 * server-side so anyone with `?profile=<name>` keeps seeing a valid
 * artifact at every moment.
 */
export const refreshProfile = async (
  client: ClientOptions,
  params: RefreshParams,
): Promise<ProfileResponse> => {
  try {
    return await apiFetch<ProfileResponse>(client, {
      method: 'POST',
      path: '/profile/refresh',
      rawBody: buildProfileBody(params),
      attemptId: params.attemptId,
    });
  } catch (err) {
    return rethrowCaptureSettingsSkew(err, client.server);
  }
};
