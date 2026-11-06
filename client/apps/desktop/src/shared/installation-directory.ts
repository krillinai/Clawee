export function resolveInstallationDirectory(
  platform: NodeJS.Platform,
  resourcesPath: string | undefined,
  packaged: boolean
): string | undefined {
  if (!packaged || resourcesPath === undefined || resourcesPath.length === 0) return undefined;

  const resourcesDirectory = parentDirectory(resourcesPath, platform);
  if (resourcesDirectory === undefined) return undefined;
  return platform === 'darwin'
    ? parentDirectory(resourcesDirectory, platform)
    : resourcesDirectory;
}

function parentDirectory(value: string, platform: NodeJS.Platform): string | undefined {
  const trimmed = value.replace(/[\\/]+$/, '');
  const slash = trimmed.lastIndexOf('/');
  const backslash = platform === 'win32' ? trimmed.lastIndexOf('\\') : -1;
  const separatorIndex = Math.max(slash, backslash);
  if (separatorIndex < 0) return undefined;
  if (separatorIndex === 0) return trimmed.slice(0, 1);
  if (platform === 'win32' && separatorIndex === 2 && trimmed[1] === ':') {
    return trimmed.slice(0, 3);
  }
  return trimmed.slice(0, separatorIndex);
}
