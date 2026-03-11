import os from 'node:os';
import path from 'node:path';

export function resolveClientHome(cwd = process.cwd()) {
  const configured = process.env.ZMAIL_HOME?.trim();
  if (configured) {
    if (configured.startsWith('~/')) {
      return path.join(os.homedir(), configured.slice(2));
    }
    if (configured === '~') {
      return os.homedir();
    }
    return configured;
  }
  return path.join(cwd, 'beta-test', 'zMail');
}

export function resolveClientPath(...parts) {
  return path.join(resolveClientHome(), ...parts);
}
