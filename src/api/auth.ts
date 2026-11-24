import { apiFetch, ClientOptions } from './client.js';
import { ApiError } from '../errors.js';

/**
 * Validate an API token by hitting `GET /profiles?limit=1` — an authed,
 * always-available endpoint that returns 401 for unknown tokens and 200
 * (with a possibly-empty array) for valid ones.
 *
 * `/pressure` was the obvious candidate but isn't routed on the cloud
 * build; `/profiles` is, and it's a cheap read regardless of how many
 * profiles the token owns thanks to the `limit=1` cap.
 *
 * Returns true on 200, false on 401, throws on anything else (5xx,
 * network error) so the caller can surface a meaningful message.
 */
export const validateToken = async (
  client: ClientOptions,
): Promise<boolean> => {
  try {
    await apiFetch(client, {
      method: 'GET',
      path: '/profiles',
      query: { limit: 1 },
    });
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return false;
    throw err;
  }
};
