// 组装 macOS arm64 应用包：基于官方 Electron.app 骨架注入应用代码，输出未签名的 mac zip
// 用法：node scripts/build-mac-zip.mjs <版本号>
import { execSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version) throw new Error("usage: node scripts/build-mac-zip.mjs <version>");
import { tmpdir } from "node:os";
const repo = join(import.meta.dirname, "..");
const releaseDir = join(repo, "release");
const electronVersion = JSON.parse(readFileSync(join(repo, "apps", "desktop", "node_modules", "electron", "package.json"), "utf8")).version;
const darwinZip = join(releaseDir, `electron-v${electronVersion}-darwin-arm64.zip`);
const workDir = join(tmpdir(), `cm-mac-build-${version}`);
const appAsar = join(releaseDir, "win-unpacked", "resources", "app.asar");
const iconPng = join(repo, "apps", "desktop", "build", "icon.png");
const outZip = join(releaseDir, `Conversation-Manager-${version}-mac-arm64.zip`);
const appName = "Conversation Manager";
const systemTar = "C:/Windows/System32/tar.exe";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });

// 1. 解压官方 darwin Electron 骨架（Windows bsdtar 可处理 zip 内的符号链接）
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
run(`"${systemTar}" -xf "${darwinZip}" -C "${workDir}"`);
const bundle = join(workDir, "Electron.app");
if (!existsSync(bundle)) throw new Error("Electron.app missing after extraction");

// 2. 注入应用 asar，移除默认应用
const resources = join(bundle, "Contents", "Resources");
copyFileSync(appAsar, join(resources, "app.asar"));
rmSync(join(resources, "default_app.asar"), { force: true });

// 3. 图标：用 512 PNG 生成 icns（ic09 条目即 512 PNG），替换默认 Electron 图标
const png = readFileSync(iconPng);
const entryLength = png.length + 8;
const entry = Buffer.concat([Buffer.from("ic09", "ascii"), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(entryLength, 0); return b; })(), png]);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, "ascii");
icnsHeader.writeUInt32BE(entryLength + 8, 4);
writeFileSync(join(resources, "electron.icns"), Buffer.concat([icnsHeader, entry]));

// 4. 重命名为发布名
const appPath = join(workDir, appName + ".app");
rmSync(appPath, { recursive: true, force: true });
execSync(`move "${bundle}" "${appPath}"`, { stdio: "ignore", shell: "cmd.exe" });

// 5. mac 端修复脚本：补应用名/标识 + 临时签名 + 去隔离标记
const fixScript = `#!/bin/sh
cd "$(dirname "$0")"
APP="${appName}.app"
plutil -replace CFBundleName -string "Conversation Manager" "$APP/Contents/Info.plist"
plutil -replace CFBundleDisplayName -string "Conversation Manager" "$APP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "com.ricardoping.cgn.desktop" "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"
xattr -cr "$APP"
echo "done: now double-click $APP"
`;
writeFileSync(join(workDir, "mac-fix.sh"), fixScript.replace(/\n/g, "\r\n"));

// 6. 打 zip（从 workDir 内部打包，zip 根含 .app 与修复脚本）
process.chdir(workDir);
run(`"${systemTar}" -a -cf "${outZip}" "${appName}.app" "mac-fix.sh"`);

console.log(`done: ${outZip} (${Math.round(statSync(outZip).size / 1024 / 1024)} MB)`);
