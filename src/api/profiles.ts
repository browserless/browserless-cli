import { apiFetch, ClientOptions } from './client.js';
import { UsageError } from '../errors.js';
import { ProfileResponse } from './upload.js';
import { terminalSafe } from '../utils/terminal.js';

export const assertCloudProfileName = (name: string): string => {
  if (
    !name ||
    name.length > 255 ||
    !/^[^\s/?#]+$/.test(name) ||
    name === '.' ||
    name === '..'
  ) {
    throw new UsageError(
      `"${terminalSafe(name)}" is not a valid cloud profile name: use 1-255 characters with no whitespace, "/", "?" or "#".`,
      'invalid-cloud-profile-name',
    );
  }
  return name;
};

export const listProfiles = async (
  client: ClientOptions,
  params: { limit?: number; offset?: number } = {},
): Promise<ProfileResponse[]> =>
  apiFetch<ProfileResponse[]>(client, {
    method: 'GET',
    path: '/profiles',
    query: {
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
    },
  });

/**
 * URL resolution collapses `/profile/..` to `/` (and `/profile/.` to
 * `/profile/`), so a dot-segment name would hit a different route than the
 * profile the user named. Thrown inside the async callers, so it rejects.
 */
const profilePath = (name: string): string => {
  if (name === '.' || name === '..') {
    throw new UsageError(`"${name}" is not a valid profile name.`);
  }
  return `/profile/${encodeURIComponent(name)}`;
};

export const getProfile = async (
  client: ClientOptions,
  name: string,
): Promise<ProfileResponse> =>
  apiFetch<ProfileResponse>(client, {
    method: 'GET',
    path: profilePath(name),
  });

export const renameProfile = async (
  client: ClientOptions,
  oldName: string,
  newName: string,
): Promise<ProfileResponse> =>
  apiFetch<ProfileResponse>(client, {
    method: 'PUT',
    path: profilePath(oldName),
    body: { name: newName },
  });

export const deleteProfile = async (
  client: ClientOptions,
  name: string,
): Promise<ProfileResponse> =>
  apiFetch<ProfileResponse>(client, {
    method: 'DELETE',
    path: profilePath(name),
  });
