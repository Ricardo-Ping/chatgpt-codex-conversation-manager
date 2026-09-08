export const DEFAULT_AUTO_UPDATE = true;

export function parseAutoUpdatePreference(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_AUTO_UPDATE;
}

export function supportsAutomaticInstallation(isPackaged: boolean, platform: NodeJS.Platform, portableExecutable?: string): boolean {
  return isPackaged && platform === "win32" && !portableExecutable;
}

export function isUpdateInstallSafe(phase: string, activeBatchCount: number): boolean {
  return phase === "downloaded" && activeBatchCount === 0;
}
