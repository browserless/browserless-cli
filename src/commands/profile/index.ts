import { Command } from 'commander';
import { registerList } from './list.js';
import { registerShow } from './show.js';
import { registerUpload } from './upload.js';
import { registerRefresh } from './refresh.js';
import { registerInspect } from './inspect.js';
import { registerLaunch } from './launch.js';
import { registerRename } from './rename.js';
import { registerDelete } from './delete.js';
import { registerTerms } from './terms.js';
import { registerProfileSources } from './sources/index.js';
import { registerProfileExclude } from './exclude/index.js';

export const registerProfile = (parent: Command): void => {
  const cmd = parent
    .command('profile')
    .description('Manage authentication profiles');

  registerList(cmd);
  registerShow(cmd);
  registerUpload(cmd);
  registerRefresh(cmd);
  registerInspect(cmd);
  registerLaunch(cmd);
  registerRename(cmd);
  registerDelete(cmd);
  registerTerms(cmd);
  registerProfileSources(cmd);
  registerProfileExclude(cmd);
};
