const isZh=(navigator.language||"zh-CN").toLowerCase().startsWith("zh");
const T=isZh?{
  detecting:"正在检测…",connected:"已连接桌面管理器",pairedWaiting:"已配对，等待桌面端",desktopRunning:"桌面端已运行，可一键连接",startDesktop:"请先启动桌面管理器",
  pair:"一键连接桌面管理器",open:"打开 ChatGPT",
  hint:"点击一次即可完成本机配对。访问令牌和 Cookie 不会发送给桌面端。",
  pairOk:"配对成功",pairFailed:(error)=>`配对失败：${error}`
}:{
  detecting:"Detecting…",connected:"Connected to desktop manager",pairedWaiting:"Paired — waiting for desktop",desktopRunning:"Desktop running — connect with one click",startDesktop:"Start the desktop manager first",
  pair:"Connect desktop manager",open:"Open ChatGPT",
  hint:"One click completes local pairing. Access tokens and cookies are never sent to the desktop.",
  pairOk:"Paired",pairFailed:(error)=>`Pairing failed: ${error}`
};
document.documentElement.lang=isZh?"zh-CN":"en";
document.querySelector("#pair").textContent=T.pair;
document.querySelector("#open").textContent=T.open;
document.querySelector(".hint").textContent=T.hint;
const statusNode=document.querySelector("#status"),pairButton=document.querySelector("#pair");
async function refresh(){const value=await chrome.runtime.sendMessage({type:"bridge-status"});statusNode.textContent=value.paired&&value.desktop?T.connected:value.paired?T.pairedWaiting:value.desktop?T.desktopRunning:T.startDesktop;pairButton.hidden=value.paired&&value.desktop}
pairButton.addEventListener("click",async()=>{pairButton.disabled=true;const result=await chrome.runtime.sendMessage({type:"pair"});statusNode.textContent=result.ok?T.pairOk:T.pairFailed(result.error);pairButton.disabled=false;if(result.ok)await refresh()});
document.querySelector("#open").addEventListener("click",()=>chrome.runtime.sendMessage({type:"open-chatgpt"}));void refresh();
