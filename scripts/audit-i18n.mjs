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
console.log("\ni18n audit passed: every t() key has an English translation.");
