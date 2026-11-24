import { UsageError } from './errors.js';

/**
 * Hardcoded map of known Browserless production region codes to their
 * server URLs. Region codes mirror the subdomain suffix (`production-<code>`)
 * so users who already know the URL can guess the region code, and vice
 * versa. Self-hosted and staging deployments don't belong here — those
 * users pass `--server <url>` (or `config set server <url>`).
 *
 * Keep this list in sync with the regions Browserless ships production
 * endpoints in. Adding a new region is a one-line change here plus a
 * spec entry.
 */
// `as const` narrows the keyof type to the literal union `'sfo' | 'lon' | 'ams'`
// — a plain `Record<string, string>` annotation widens it back to `string`.
export const REGION_URLS = {
  sfo: 'https://production-sfo.browserless.io',
  lon: 'https://production-lon.browserless.io',
  ams: 'https://production-ams.browserless.io',
} as const;

export type RegionCode = keyof typeof REGION_URLS;

export const KNOWN_REGIONS = Object.keys(REGION_URLS) as RegionCode[];

export const isKnownRegion = (input: string): input is RegionCode =>
  Object.prototype.hasOwnProperty.call(REGION_URLS, input);

/**
 * Resolve a region code to its server URL. Throws `UsageError` listing
 * the known codes if the input is unrecognised.
 */
export const regionToServerUrl = (region: string): string => {
  if (!isKnownRegion(region)) {
    throw new UsageError(
      `Unknown region "${region}". Known regions: ${KNOWN_REGIONS.join(', ')}. ` +
        `For self-hosted or staging, pass --server <url> instead.`,
      'unknown-region',
    );
  }
  return REGION_URLS[region];
};
