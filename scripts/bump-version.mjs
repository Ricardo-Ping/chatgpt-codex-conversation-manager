// One-shot version bump across every location that hardcodes the release
// version: root/desktop/package manifests, extension manifest, MCP server
// constant, and the README download links. Usage: node scripts/bump-version.mjs 0.7.2
import fs from "node:fs";

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) {
  console.error("usage: node scripts/bump-version.mjs <x.y.z[-prerelease]>");
  process.exit(1);
}

const rootPkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const previous = rootPkg.version;
if (previous === next) {
  console.log(`already at ${next}; nothing to do`);
  process.exit(0);
}

const manifests = [
  "package.json",
  "apps/desktop/package.json",
  "packages/chatgpt-bridge-server/package.json",
  "packages/codex-app-server-adapter/package.json",
  "packages/conversation-domain/package.json",
  "packages/chatgpt-browser-bridge-extension/package.json",
  "companion-plugin/mcp/package.json"
];
for (const file of manifests) {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = next;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

// 扩展清单（manifest version 3 无关字段，仅替换版本行避免键顺序变化）
const manifest = "packages/chatgpt-browser-bridge-extension/manifest.json";
fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace(`"version": "${previous}"`, `"version": "${next}"`));

// MCP server 常量
const mcpIndex = "companion-plugin/mcp/src/index.ts";
fs.writeFileSync(mcpIndex, fs.readFileSync(mcpIndex, "utf8").replaceAll(previous, next));

// README 下载链接与支持说明
for (const readme of ["README.md", "README.en.md"]) {
  fs.writeFileSync(readme, fs.readFileSync(readme, "utf8").replaceAll(previous, next));
}

console.log(`bumped ${previous} -> ${next}:`);
for (const file of [...manifests, manifest, mcpIndex, "README.md", "README.en.md"]) console.log(`  ${file}`);
console.log("\nnext: commit, tag vX.Y.Z and push the tag to trigger the release workflow");
