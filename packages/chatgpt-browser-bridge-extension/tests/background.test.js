const test=require("node:test"),assert=require("node:assert/strict");

function loadBackground(chrome){ globalThis.chrome=chrome; delete require.cache[require.resolve("../background.js")]; return require("../background.js"); }

test("injects the content bridge when an existing ChatGPT tab has no receiver",async()=>{
  let sends=0,injected=null;
  const chrome={runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}},storage:{local:{async get(){return{}},async set(){},async remove(){}}},tabs:{async query(){return[]},async sendMessage(){if(++sends===1)throw new Error("Receiving end does not exist");return{ok:true}},create(){}},scripting:{async executeScript(value){injected=value}}};
  const {sendToChatGptTab}=loadBackground(chrome);
  await assert.doesNotReject(()=>sendToChatGptTab(7,{type:"accounts"}));
  assert.deepEqual(JSON.parse(JSON.stringify(injected)),{target:{tabId:7},files:["bridge-core.js","content.js"]});assert.equal(sends,2);
});

test("does not inject scripts for unrelated messaging failures",async()=>{
  let injected=false;
  const chrome={runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}},storage:{local:{async get(){return{}},async set(){},async remove(){}}},tabs:{async query(){return[]},async sendMessage(){throw new Error("Tab was closed")},create(){}},scripting:{async executeScript(){injected=true}}};
  const {sendToChatGptTab}=loadBackground(chrome);
  await assert.rejects(()=>sendToChatGptTab(7,{type:"accounts"}),/Tab was closed/);assert.equal(injected,false);
});
