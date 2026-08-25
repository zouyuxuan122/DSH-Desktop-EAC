import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function canReuseStagedNodeModules(skipNpm, targetPlatform, nodeModules, stampFile) {
  if (!skipNpm || !existsSync(nodeModules) || !existsSync(stampFile)) return false;
  try {
    return readFileSync(stampFile, 'utf8').trim() === targetPlatform;
  } catch {
    return false;
  }
}

export function writeStagedPlatformStamp(stampFile, targetPlatform) {
  writeFileSync(stampFile, `${targetPlatform}\n`, 'utf8');
}
