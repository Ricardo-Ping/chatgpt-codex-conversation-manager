const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),{readFileSync}=require("node:fs"),{join}=require("node:path");

test("injects the content bridge when an existing ChatGPT tab has no receiver",async()=>{
  let sends=0,injected=null;
  const chrome={runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}},storage:{local:{async get(){return{}},async set(){},async remove(){}}},tabs:{async query(){return[]},async sendMessage(){if(++sends===1)throw new Error("Receiving end does not exist");return{ok:true}},create(){}},scripting:{async executeScript(value){injected=value}}};
  const context={chrome,fetch:async()=>{throw new Error("unexpected fetch")},setTimeout,clearTimeout,console};context.globalThis=context;
  const source=`${readFileSync(join(__dirname,"..","background.js"),"utf8")}\n;globalThis.sendToChatGptTabForTest=sendToChatGptTab;`;
  vm.runInNewContext(source,context);
  await assert.doesNotReject(()=>context.sendToChatGptTabForTest(7,{type:"accounts"}));
  assert.deepEqual(JSON.parse(JSON.stringify(injected)),{target:{tabId:7},files:["bridge-core.js","content.js"]});assert.equal(sends,2);
});

test("does not inject scripts for unrelated messaging failures",async()=>{
  let injected=false;
  const chrome={runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}},storage:{local:{async get(){return{}},async set(){},async remove(){}}},tabs:{async query(){return[]},async sendMessage(){throw new Error("Tab was closed")},create(){}},scripting:{async executeScript(){injected=true}}};
  const context={chrome,fetch:async()=>{throw new Error("unexpected fetch")},setTimeout,clearTimeout,console};context.globalThis=context;
  const source=`${readFileSync(join(__dirname,"..","background.js"),"utf8")}\n;globalThis.sendToChatGptTabForTest=sendToChatGptTab;`;
  vm.runInNewContext(source,context);
  await assert.rejects(()=>context.sendToChatGptTabForTest(7,{type:"accounts"}),/Tab was closed/);assert.equal(injected,false);
});
