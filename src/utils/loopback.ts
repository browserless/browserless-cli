/** True for hostnames that only ever resolve to this machine. */
export const isLoopbackHostname = (hostname: string): boolean => {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
};
