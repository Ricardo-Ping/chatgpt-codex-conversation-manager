import { join } from "node:path";

export interface ExtensionSession {
  extensions: {
    loadExtension(path: string, options?: { allowFileAccess?: boolean }): Promise<{ id: string; name: string }>;
  };
}

export function extensionDirectory(appPath: string, resourcesPath: string, packaged: boolean): string {
  return packaged
    ? join(resourcesPath, "chatgpt-extension")
    : join(appPath, "..", "..", "packages", "chatgpt-web-adapter", "vendor", "extension");
}

export async function loadChatGptExtension(target: ExtensionSession, directory: string): Promise<{ id: string; name: string }> {
  return target.extensions.loadExtension(directory, { allowFileAccess: false });
}
