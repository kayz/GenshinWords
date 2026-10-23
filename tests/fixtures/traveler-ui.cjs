const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const Database=require('better-sqlite3');
const {app,BrowserWindow}=require('electron');
const {setTimeout:delay}=require('node:timers/promises');
const {fixture}=require('../helpers/practice-fixture.cjs');
const {root}=require('../helpers/load-main.cjs');
const callbacks=[];
let win;
app.setPath('userData',process.argv[2]);
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
const evaluate=code=>win.webContents.executeJavaScript(code,true);
async function waitFor(code){
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(await evaluate(code))return;await delay(60);}
  throw Error('UI timeout: '+code+'\n'+await evaluate('document.body.innerText'));
}
async function capture(name){
  if(!process.env.GENSHINWORDS_UI_ARTIFACTS)return;
  await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
  await delay(120);
  await fs.mkdir(process.env.GENSHINWORDS_UI_ARTIFACTS,{recursive:true});
  await fs.writeFile(path.join(process.env.GENSHINWORDS_UI_ARTIFACTS,name+'.png'),(await win.webContents.capturePage()).toPNG());
}
async function clickText(text){
  await waitFor('Array.from(document.querySelectorAll("a,button")).some(el=>el.textContent.trim()==='+JSON.stringify(text)+')');
  await evaluate('Array.from(document.querySelectorAll("a,button")).find(el=>el.textContent.trim()==='+JSON.stringify(text)+').click()');
}
(async()=>{
  await app.whenReady();
  const f=fixture({after:callback=>callbacks.push(callback)});
  const writable=new Database(f.contentPath);
  writable.exec("CREATE TABLE speakers(name TEXT PRIMARY KEY,image_path TEXT,icon_path TEXT,image_kind TEXT); INSERT INTO speakers VALUES('Traveler',NULL,'female.webp',NULL); UPDATE dialog_lines SET speaker='Traveler' WHERE id=1;");
  writable.close();
  f.progress.setSetting('currentBook','test');
  const row=f.study.ensureCard(3,'test');
  f.progress.upsertCard({...row,reps:1,state:2,due:'2000-01-01T00:00:00.000Z'});
  f.context.load('ipc').registerIpc();
  win=new BrowserWindow({show:false,width:1024,height:768,useContentSize:true,webPreferences:{preload:path.join(root,'out/preload/index.js'),sandbox:true,contextIsolation:true}});
  const errors=[];
  win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message);});
  await win.loadFile(path.join(root,'out/renderer/index.html'),{hash:'/review'});
  await waitFor('!!document.querySelector("[data-traveler-choice=aether]")');
  assert.equal(await evaluate('!!document.querySelector(".gw-nav")'),false);
  await waitFor('Array.from(document.querySelectorAll(".gw-traveler-choice img")).every(image=>image.complete&&image.naturalWidth>0)');
  for(const width of [1024,819]){
    win.setContentSize(width,600);await delay(100);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'),true);
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".gw-traveler-choice")).every(el=>el.getBoundingClientRect().left>=0&&el.getBoundingClientRect().right<=window.innerWidth)'),true);
    await capture('first-choice-'+width);
  }
  win.setContentSize(1024,768);await delay(100);
  await evaluate('document.querySelector("[role=dialog]").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  assert.equal(await evaluate('!!document.querySelector("[data-traveler-choice=aether]")'),true);
  await evaluate('document.querySelector("[data-traveler-choice=aether]").click()');
  await waitFor('document.querySelector(".gw-word")?.textContent==="sword"');
  await waitFor('document.querySelector(".gw-review-art")?.naturalWidth>0');
  assert.equal(f.progress.getSetting('traveler'),'aether');
  await capture('aether-review');
  assert.equal(await evaluate('document.querySelector(".gw-review-art").getAttribute("data-portrait-path")'),'bundled/aether-companion.webp');
  assert.equal(await evaluate('document.querySelector(".gw-traveler-toggle img").dataset.travelerAvatar'),'aether');
  await evaluate('document.querySelector(".gw-traveler-toggle").click()');
  await waitFor('!!document.querySelector("[data-traveler-choice=lumine]")');
  await evaluate('document.querySelector("[data-traveler-choice=lumine]").click()');
  await waitFor('document.querySelector(".gw-review-art")?.dataset.portraitPath==="bundled/lumine-companion.webp"');
  assert.equal(f.progress.getSetting('traveler'),'lumine');
  await capture('lumine-review');
  win.webContents.reload();
  await waitFor('document.querySelector(".gw-review-art")?.dataset.portraitPath==="bundled/lumine-companion.webp"');
  assert.equal(await evaluate('!!document.querySelector("[role=dialog]")'),false);
  await win.loadFile(path.join(root,'out/renderer/index.html'),{hash:'/browse?chapterId=1&questId=1'});
  await waitFor('!!document.querySelector(".gw-avatar[data-traveler-avatar=lumine]")');
  await evaluate('document.querySelector(".gw-traveler-toggle").click()');
  await waitFor('!!document.querySelector("[data-traveler-choice=aether]")');
  await evaluate('document.querySelector("[data-traveler-choice=aether]").click()');
  await waitFor('!!document.querySelector(".gw-avatar[data-traveler-avatar=aether]")');
  await win.loadFile(path.join(root,'out/renderer/index.html'),{hash:'/about'});
  await clickText('重新选择空或荧');
  await waitFor('!!document.querySelector("[data-traveler-choice=lumine]")');
  await evaluate('document.querySelector("[data-traveler-choice=lumine]").click()');
  await waitFor('document.querySelector(".gw-traveler-settings h2")?.textContent.includes("荧")');
  assert.equal(f.progress.getSetting('traveler'),'lumine');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,flow:'first choice -> live portrait/avatar -> reload -> browse/avatar -> About reselection'}));
})().then(()=>finish(0),error=>{console.error(error);finish(1);});
function finish(code){win?.destroy();try{for(const callback of callbacks)callback();}catch(error){console.error(error);code=1;}app.exit(code);}
