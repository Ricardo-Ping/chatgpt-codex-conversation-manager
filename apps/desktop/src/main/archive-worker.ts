// 打包/导入 Codex 会话的 worker 入口：zipSync/unzipSync 是 CPU 密集的同步操作，
// 直接在主进程执行会阻塞事件循环导致应用"未响应"，因此整体挪到独立线程执行。
import { parentPort, workerData } from "node:worker_threads";
import { readFile, writeFile } from "node:fs/promises";
import { buildSessionsArchive, extractSessionsArchive } from "./codex-sessions-archive.js";

interface ArchiveJob {
  mode: "export" | "import";
  codexHome: string;
  outFile?: string;
  zipPath?: string;
}

const job = workerData as ArchiveJob;
const port = parentPort;
const post = (message: Record<string, unknown>): void => { port?.postMessage(message); };

async function run(): Promise<void> {
  if (job.mode === "export") {
    post({ type: "progress", phase: "collect" });
    const { zip, count, bytes } = await buildSessionsArchive(job.codexHome, (files) => post({ type: "progress", phase: "zip", files }));
    await writeFile(job.outFile!, zip);
    post({ type: "done", count, bytes });
    return;
  }
  const zip = new Uint8Array(await readFile(job.zipPath!));
  const { imported, skipped } = await extractSessionsArchive(zip, job.codexHome);
  post({ type: "done", imported, skipped });
}

run().then(
  () => process.exit(0),
  (error) => {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
);
