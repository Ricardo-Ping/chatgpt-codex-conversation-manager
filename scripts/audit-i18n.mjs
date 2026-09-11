// Audits renderer t() call sites against the EN dictionary in strings.ts.
// Chinese text is the key language: t() falls back to the key itself when the
// EN dictionary has no entry, so a missing entry silently shows Chinese in the
// English UI. This script fails CI on any such gap.
// Usage: node scripts/audit-i18n.mjs
import fs from "node:fs";
import path from "node:path";

const srcDir = "apps/desktop/src/renderer";
const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));
const dictSrc = fs.readFileSync(path.join(srcDir, "strings.ts"), "utf8");

const enStart = dictSrc.indexOf("const en");
const zhStart = dictSrc.indexOf("const zh", enStart);
const enBlock = dictSrc.slice(enStart, zhStart);

function keys(block) {
  const set = new Set();
  const re = /^\s*"((?:[^"\\]|\\.)*)":/gm;
  let m;
  while ((m = re.exec(block))) set.add(m[1]);
  return set;
}

const enKeys = keys(enBlock);

const used = new Map();
const tCall = /(?<![\w.$])t\(\s*"((?:[^"\\]|\\.)*)"/g;
for (const f of files) {
  if (f === "strings.ts" || f.endsWith(".test.ts")) continue;
  const src = fs.readFileSync(path.join(srcDir, f), "utf8");
  let m;
  while ((m = tCall.exec(src))) {
    if (!used.has(m[1])) used.set(m[1], f);
  }
}

const missingInEn = [...used.keys()].filter((k) => !enKeys.has(k));
console.log(`t() literal call sites: ${used.size}`);
console.log(`--- keys missing in EN dict: ${missingInEn.length}`);
for (const k of missingInEn) console.log(`  [${used.get(k)}] ${k}`);

// Dict entries that no literal t() call references are usually reached through
// dynamic keys (state maps, relative-time buckets), so report but never fail.
const neverReferenced = [...enKeys].filter((k) => !used.has(k));
console.log(`--- EN entries reached only via dynamic keys (informational): ${neverReferenced.length}`);

if (missingInEn.length > 0) {
  console.error(`\ni18n audit FAILED: ${missingInEn.length} key(s) have no English translation.`);
  process.exit(1);
}

// 主进程词典（MAIN_STRINGS）：zh/en 两块结构相同、按属性名索引，校验键集合一致。
// 类型系统已约束，这里作为 CI 可见的冗余守卫，防止有人把类型注解放宽后悄悄漏译。
const mainStringsPath = "apps/desktop/src/main/strings.ts";
const mainSrc = fs.readFileSync(mainStringsPath, "utf8");
function blockKeys(startMarker) {
  const start = mainSrc.indexOf(startMarker);
  if (start === -1) return null;
  const end = mainSrc.indexOf("\n};", start);
  const block = mainSrc.slice(start, end);
  const keys = new Set();
  const keyRe = /^\s{2}(\w+):/gm;
  let km;
  while ((km = keyRe.exec(block))) keys.add(km[1]);
  return keys;
}
const mainZhKeys = blockKeys("const zh: MainStrings = {");
const mainEnKeys = blockKeys("const en: MainStrings = {");
if (!mainZhKeys || !mainEnKeys) {
  console.error(`i18n audit FAILED: cannot locate zh/en blocks in ${mainStringsPath}`);
  process.exit(1);
}
const zhOnly = [...mainZhKeys].filter((k) => !mainEnKeys.has(k));
const enOnly = [...mainEnKeys].filter((k) => !mainZhKeys.has(k));
if (zhOnly.length || enOnly.length) {
  console.error(`\nmain i18n audit FAILED: zh/en key mismatch in ${mainStringsPath}`);
  if (zhOnly.length) console.error(`  zh only: ${zhOnly.join(", ")}`);
  if (enOnly.length) console.error(`  en only: ${enOnly.join(", ")}`);
  process.exit(1);
}

console.log("\ni18n audit passed: every t() key has an English translation; main zh/en dictionaries match.");
