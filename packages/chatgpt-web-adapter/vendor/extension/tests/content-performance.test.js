const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

test("content scanner keeps image-only and cached parsing paths", () => {
  assert.match(content, /getParsedMessage\(el, roleHint\)/);
  assert.match(content, /messageParseCache\s*=\s*new WeakMap/);
  assert.match(content, /role === "user" \? "图片提问"/);
  assert.match(content, /dirtyMessageElements/);
});

test("viewport highlighting does not scan every row on every scroll", () => {
  assert.match(content, /new IntersectionObserver/);
  assert.match(content, /messageByElement\.get\(best\)/);
  assert.doesNotMatch(content, /messages\.find\(\(message\) => message\.element === best\)/);
  assert.match(content, /previousRow\?\.classList\.remove\("cg-lite-item-current"\)/);
  assert.doesNotMatch(content, /container\.addEventListener\("scroll", onScroll/);
});

test("branch lifecycle is event driven and native pointer drag remains available", () => {
  assert.doesNotMatch(content, /lifecycleTimer\s*=\s*setInterval/);
  assert.match(content, /chrome\.storage\.onChanged\.addListener/);
  assert.match(content, /routeMonitorTimer\s*=\s*setInterval/);
  assert.match(content, /unlike the old loop it\s*\n\s*\/\/ performs no storage or network reads/);
  assert.match(content, /liveMessageRoot !== messageRoot\) installObserver\(\)/);
  assert.match(content, /installPointerDragFallback/);
  assert.match(content, /compositionstart/);
  assert.match(content, /if \(imeComposing \|\| event\.isComposing\) return/);
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js);
  assert.doesNotMatch(scripts.join("\n"), /interact\.min\.js/);
});

test("viewport cache resolves by message key across filtered message arrays", () => {
  assert.match(content, /if \(cachedViewportMessageKey\) \{\s*const observedIndex = messages\.findIndex/);
  assert.doesNotMatch(content, /viewportRuntime\?\.messages === messages && cachedViewportMessageKey/);
});

test("same-text DOM replacement invalidates navigation row closures", () => {
  assert.match(content, /messageDomVersion\s*\+=\s*1/);
  assert.match(content, /message\.element !== cachedMessages\[index\]\?\.element/);
  assert.match(content, /appState\.panel\?\.height,\s*messageDomVersion,\s*nodeSignature/);
});

test("render signature includes node binding and missing state", () => {
  assert.match(content, /node\.messageKey/);
  assert.match(content, /node\.messageHash/);
  assert.match(content, /Boolean\(node\.missing\)/);
});

test("render signature invalidates after native drag and resize", () => {
  assert.match(content, /appState\.liteDock\?\.side/);
  assert.match(content, /appState\.liteDock\?\.y/);
  assert.match(content, /appState\.compactDock\?\.side/);
  assert.match(content, /appState\.compactDock\?\.y/);
  assert.match(content, /appState\.panelDock\?\.side/);
  assert.match(content, /appState\.panelDock\?\.y/);
  assert.match(content, /appState\.panel\?\.width/);
  assert.match(content, /appState\.panel\?\.height/);
});
