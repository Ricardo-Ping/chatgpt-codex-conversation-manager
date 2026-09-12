// 一键全量校验：按 workspace 拓扑序对每个包执行 build → typecheck → test。
// 刻意不依赖 pnpm（npm run 逐包执行），保证在任何 agent / CI / 裸 shell 里都能跑——
// "本地没验证、CI 反复挂"的事故（如 v0.7.7 的 TS2345）均源于推送前缺少可靠的全量校验。
// 用法：node scripts/verify-all.mjs（或 npm run verify）。任一步骤失败立即终止并退出非零。
import { readdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const PHASES = ["build", "typecheck", "test"];
function workspaceGlobs(manifest) {
  const lines = manifest.split("\n").map((line) => line.trim());
  const start = lines.indexOf("packages:");
  if (start === -1) throw new Error("pnpm-workspace.yaml 缺少 packages: 段");
  const globs = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("-")) break;
    globs.push(line.slice(1).trim().replace(/^['"]|['"]$/g, ""));
  }
  return globs;
}

function expandGlob(pattern) {
  const base = resolve(root, pattern.replace(/\/?\*.*$/, ""));
  if (!pattern.includes("*")) return existsSync(join(base, "package.json")) ? [base] : [];
  if (!existsSync(base)) return [];
  return readdirSync(base).map((name) => join(base, name)).filter((dir) => existsSync(join(dir, "package.json")));
}

const globs = workspaceGlobs(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"));
const dirs = [...new Set(globs.flatMap(expandGlob))];
if (!dirs.length) throw new Error("workspace 未发现任何包，请在仓库根目录运行");

const packages = new Map();
for (const dir of dirs) {
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (!manifest.name) continue;
  packages.set(manifest.name, { name: manifest.name, dir, scripts: manifest.scripts ?? {}, deps: { ...manifest.dependencies, ...manifest.devDependencies } });
}

// Kahn 拓扑排序：包排在其 workspace 依赖之后，保证 bridge-server 等基础包先于 desktop 构建
const remaining = new Map([...packages].map(([name, pkg]) => [name, Object.keys(pkg.deps ?? {}).filter((dep) => packages.has(dep))]));
const order = [];
while (remaining.size) {
  const ready = [...remaining.entries()].filter(([, deps]) => deps.every((dep) => !remaining.has(dep)));
  if (!ready.length) throw new Error(`workspace 依赖成环：${[...remaining.keys()].join(", ")}`);
  for (const [name] of ready) { order.push(name); remaining.delete(name); }
}

for (const phase of PHASES) {
  for (const name of order) {
    const pkg = packages.get(name);
    if (!pkg.scripts[phase]) continue;
    console.log(`\n==== ${phase} @ ${pkg.name} ====`);
    const result = spawnSync("npm", ["run", phase], { cwd: pkg.dir, shell: true, encoding: "utf8", env: process.env });
    if (result.status !== 0) {
      console.error(`\n## ${phase} @ ${pkg.name} 失败（exit ${result.status ?? "?"}），输出末尾：\n`);
      console.error(`${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").slice(-40).join("\n"));
      process.exit(1);
    }
  }
}

// 根级 lint（与 CI 的第 4 步对齐）：放在最后，输出最短
console.log("\n==== lint @ root ====");
const lint = spawnSync("npm", ["run", "lint"], { cwd: root, shell: true, encoding: "utf8", env: process.env });
if (lint.status !== 0) {
  console.error(`${lint.stdout ?? ""}\n${lint.stderr ?? ""}`);
  process.exit(1);
}
console.log(`\n全部通过：${order.length} 个包 × ${PHASES.join(" / ")} + 根级 lint`);
