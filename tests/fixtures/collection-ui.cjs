const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { fixture } = require('../helpers/practice-fixture.cjs');
const { root } = require('../helpers/load-main.cjs');
const callbacks = [];
let win;
app.setPath('userData', process.argv[2]);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
async function evaluate(code) { return win.webContents.executeJavaScript(code, true); }
async function waitFor(code) {
  const until=Date.now()+8000;
  while(Date.now()<until) {
    if(await evaluate(code)) return;
    await delay(50);
  }
  throw new Error('UI condition timed out: '+code+'\n'+await evaluate('document.body.innerText'));
}
async function click(label) {
  const text=JSON.stringify(label);
  await waitFor('Array.from(document.querySelectorAll("a,button")).some(el=>el.textContent.trim()==='+text+')');
  assert.equal(await evaluate('(()=>{const el=Array.from(document.querySelectorAll("a,button")).find(el=>el.textContent.trim()==='+text+');if(!el||el.disabled)return false;el.click();return true;})()'),true);
}
(async()=>{
  await app.whenReady();
  const f=fixture({after:fn=>callbacks.push(fn)});
  f.progress.setSetting('traveler', 'lumine');
  f.context.load('ipc').registerIpc();
  win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{preload:path.join(root,'out/preload/index.js'),sandbox:true,contextIsolation:true}});
  await win.loadFile(path.join(root,'out/renderer/index.html'),{hash:'/browse?chapterId=1&questId=1&lineId=5'});
  await waitFor('Array.from(document.querySelectorAll(".gw-token")).some(el=>el.textContent==="Extra")');
  await evaluate('Array.from(document.querySelectorAll(".gw-token")).find(el=>el.textContent==="Extra").click()');
  await waitFor('document.body.innerText.includes("已收录到收藏词表")');
  assert.equal(f.context.load('collections').listCollection().length,1);
  assert.equal(f.progress.getSetting('currentBook'),'');

  await click('收藏词表');
  await waitFor('document.querySelectorAll(".gw-collection-entry").length===1');
  await click('复习收藏词');
  await waitFor('document.querySelector(".gw-word")?.textContent==="extra"');
  await click('显示释义与台词');
  await waitFor('document.querySelector(".gw-example")?.textContent.includes("Extra matters here.")');
  assert.ok(!(await evaluate('document.querySelector(".gw-example").textContent')).includes('Keep it.'));
  await waitFor('!!document.querySelector(".gw-rate .good")');
  await evaluate('document.querySelector(".gw-rate .good").click()');
  await click('检查刚复习的词');
  await waitFor('!!document.querySelector(".gw-cloze input")');
  assert.ok((await evaluate('location.hash')).includes('scope=collection'));
  assert.ok((await evaluate('document.body.innerText')).includes('收录时原句'));
  assert.ok(!(await evaluate('document.querySelector(".gw-reading-text").textContent')).includes('Keep it.'));
  await evaluate('(()=>{const input=document.querySelector(".gw-cloze input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"extra");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await click('检查答案');
  await waitFor('document.body.innerText.includes("获得 1 原石")');
  assert.equal(f.rewards.getRewards().total,1);
  assert.equal(f.progress.getCard(5,'test'),undefined);
  await click('检查下一个词');
  await waitFor('!!document.querySelector(".gw-cloze input") && !document.querySelector(".gw-cloze input").disabled');
  assert.ok((await evaluate('location.hash')).includes('scope=collection'));

  await click('收藏词表');
  await waitFor('document.querySelectorAll(".gw-collection-entry").length===1');
  await click('移出收藏');
  await waitFor('document.body.innerText.includes("词表还是空的呢")');
  await click('撤销移除');
  await waitFor('document.querySelectorAll(".gw-collection-entry").length===1');
  await click('回到来源台词');
  await waitFor('document.querySelector(".gw-source-line")?.textContent.includes("Extra matters here.")');
  console.log(JSON.stringify({ok:true,flow:'collect → review → source-only test → reward → remove/undo → source navigation'}));
})().then(()=>finish(0),error=>{console.error(error);finish(1);});
function finish(code) {
  win?.destroy();
  try { for(const callback of callbacks) callback(); } catch(error) { console.error(error);code=1; }
  app.exit(code);
}
