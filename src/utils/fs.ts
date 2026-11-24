import fs from 'node:fs/promises';

/** True if `p` is reachable via `fs.access` (file or directory), false otherwise. */
export const pathExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};
