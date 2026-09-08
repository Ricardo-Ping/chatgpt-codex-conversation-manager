const statusNode=document.querySelector("#status"),pairButton=document.querySelector("#pair");
async function refresh(){const value=await chrome.runtime.sendMessage({type:"bridge-status"});statusNode.textContent=value.paired&&value.desktop?"已连接桌面管理器":value.paired?"已配对，等待桌面端":value.desktop?"桌面端已运行，可一键连接":"请先启动桌面管理器";pairButton.hidden=value.paired&&value.desktop}
pairButton.addEventListener("click",async()=>{pairButton.disabled=true;const result=await chrome.runtime.sendMessage({type:"pair"});statusNode.textContent=result.ok?"配对成功":`配对失败：${result.error}`;pairButton.disabled=false;if(result.ok)await refresh()});
document.querySelector("#open").addEventListener("click",()=>chrome.runtime.sendMessage({type:"open-chatgpt"}));void refresh();
