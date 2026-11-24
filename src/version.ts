/**
 * CLI version. Bumped in lockstep with package.json on each release.
 * Hardcoded (rather than read from package.json at runtime) so it
 * resolves the same way under `npm run build`, when run from the
 * published npm tarball, and from spec files compiled into `build/`.
 */
export const version = '0.7.0'; // x-release-please-version
