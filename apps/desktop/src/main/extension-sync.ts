import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const EXTENSION_FILES = ["manifest.json", "background.js", "content.js", "bridge-core.js", "popup.html", "popup.css", "popup.js"];

/** 把内置扩展文件同步到稳定目录（~/.conversation-manager/extension）。
 * Chrome 只需加载该目录一次：之后每次应用启动/更新时这里都会刷新文件，
 * 配合扩展自身的自动重载即可持续升级，无需人工重新加载。
 * 只在文件缺失或内容变化时写入，避免无谓地触发 Chrome 的文件变更检测。
 * 单个文件被占用（浏览器/杀软瞬时锁定）时跳过该文件，不影响其余文件的同步；
 * 返回值包含未写入的文件名，由调用方决定是否告警。 */
export async function syncExtensionFiles(sourceDir: string, targetDir: string, files: readonly string[] = EXTENSION_FILES): Promise<{ targetDir: string; skipped: string[] }> {
  await mkdir(targetDir, { recursive: true });
  const skipped: string[] = [];
  for (const file of files) {
    const incoming = await readFile(join(sourceDir, file));
    let current: Buffer | null = null;
    try { current = await readFile(join(targetDir, file)); } catch {}
    if (!current || !current.equals(incoming)) {
      try { await copyFile(join(sourceDir, file), join(targetDir, file)); } catch { skipped.push(file); }
    }
  }
  return { targetDir, skipped };
}
