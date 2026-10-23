const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { loadMain, root } = require('../helpers/load-main.cjs');
const output = process.argv[3];
const baseline = process.argv.includes('--baseline');
const results = [];
const errors = [];
const requests = [];
let win, context, pageRun = 0;
app.setPath('userData', process.argv[2]);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});
const evaluate = code => win.webContents.executeJavaScript(code, true);
async function waitFor(code) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await evaluate(code)) return;
    await delay(60);
  }
  throw Error('UI timeout: ' + code + '\n' + await evaluate('document.body.innerText'));
}
async function open(hash, ready) {
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { hash, query: { uiAuditRun: String(++pageRun) } });
  await waitFor(ready);
  await evaluate('document.fonts.ready');
  await delay(800);
}
async function capture(name) {
  await fs.promises.mkdir(output, { recursive: true });
  win.webContents.invalidate();
  await delay(120);
  fs.writeFileSync(path.join(output, (baseline ? 'before-' : '') + name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function measurePage() {
  function rgba(value) {
    const v = value.match(/[\d.]+/g)?.map(Number);
    return v ? [v[0], v[1], v[2], v.length > 3 ? v[3] : 1] : [0, 0, 0, 0];
  }
  function over(fg, bg) { return fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3])).concat(1); }
  function background(el) {
    const own = rgba(getComputedStyle(el).backgroundColor);
    return own[3] === 1 ? own : over(own, el.parentElement ? background(el.parentElement) : [255, 255, 255, 1]);
  }
  function luminance(c) {
    return c.slice(0, 3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
      .reduce((a, n, i) => a + n * [.2126, .7152, .0722][i], 0);
  }
  function contrast(fg, bg) { const a = luminance(fg), b = luminance(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }
  const lowContrast = [], overflow = [], text = [];
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!rect.width || !rect.height || style.visibility !== 'visible' || style.display === 'none') continue;
    if (rect.left < -1 || rect.right > innerWidth + 1) overflow.push({ tag: el.tagName, class: el.className, left: rect.left, right: rect.right });
    const ownText = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
    if (!/\p{L}|\p{N}/u.test(ownText) || el.closest(':disabled, select, [aria-hidden="true"]')) continue;
    const bg = background(el);
    let fg = rgba(style.color);
    let opacity = 1;
    for (let p = el; p; p = p.parentElement) opacity *= Number(getComputedStyle(p).opacity);
    fg[3] *= opacity;
    const ratio = contrast(over(fg, bg), bg);
    const entry = { text: ownText.slice(0, 55), ratio: Math.round(ratio * 100) / 100, size: style.fontSize, color: style.color };
    text.push(entry);
    if (ratio < 4.5) lowContrast.push(entry);
  }
  for (const el of document.querySelectorAll('input, select')) {
    if (el.disabled || !el.getBoundingClientRect().width) continue;
    const placeholder = el instanceof HTMLInputElement && !el.value && !!el.placeholder;
    const style = getComputedStyle(el, placeholder ? '::placeholder' : null);
    const bg = background(el);
    const ratio = contrast(over(rgba(style.color), bg), bg);
    const entry = { text: placeholder ? el.placeholder : (el.value || el.textContent).slice(0, 55), ratio: Math.round(ratio * 100) / 100, size: style.fontSize, color: style.color };
    text.push(entry);
    if (ratio < 4.5) lowContrast.push(entry);
  }
  const rate = document.querySelector('.gw-rate')?.getBoundingClientRect();
  const scroll = document.querySelector('.gw-answer-scroll');
  return {
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
    overflow: overflow.slice(0, 10), lowContrast, minContrast: Math.min(...text.map(x => x.ratio)),
    textCount: text.length, fontLoaded: document.fonts.check('500 20px "Noto Serif SC"', '提瓦特荧'),
    rateVisible: !rate || (rate.top >= 0 && rate.bottom <= innerHeight),
    answerScrollable: !!scroll && scroll.scrollHeight > scroll.clientHeight + 1,
    portrait: document.querySelector('.gw-review-art')?.getAttribute('data-portrait-path'),
    portraitLoaded: !!document.querySelector('.gw-review-art')?.naturalWidth,
    cardColumns: document.querySelector('.gw-review-card') && getComputedStyle(document.querySelector('.gw-review-card')).gridTemplateColumns,
  };
}
async function inspect(name, options = {}) {
  await evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>null))).then(()=>true)');
  await delay(80);
  const measured = await evaluate('(' + measurePage.toString() + ')()');
  results.push({ name, ...measured });
  if (options.capture) await capture(name);
  if (baseline) return;
  assert.ok(measured.scrollWidth <= measured.clientWidth + 1, name + ': page horizontal overflow');
  assert.deepEqual(measured.overflow, [], name + ': element horizontal overflow');
  assert.deepEqual(measured.lowContrast, [], name + ': text contrast below 4.5:1');
  assert.equal(measured.fontLoaded, true, name + ': bundled font not loaded');
  if (options.review) {
    assert.equal(measured.rateVisible, true, name + ': rating buttons outside viewport');
    assert.equal(measured.portraitLoaded, true, name + ': missing portrait');
    assert.ok(!measured.portrait.includes('landscape'), name + ': landscape used');
  }
  if (options.companion) assert.equal(measured.portrait, 'bundled/lumine-companion.webp');
  if (options.long) assert.equal(measured.answerScrollable, true, name + ': long source must scroll inside card');
}
(async () => {
  await app.whenReady();
  context = loadMain(path.join(root, 'content/content.db'), path.join(process.argv[2], 'progress.db'));
  const content = context.load('content-db'), progress = context.load('progress-db'), study = context.load('study');
  const rewards = context.load('rewards'), collections = context.load('collections'), exercise = context.load('exercise');
  const ipc = context.load('ipc');
  const bookId = content.listBooks()[0].id;
  progress.setSetting('currentBook', bookId);
  progress.setSetting('traveler', 'lumine');
  ipc.registerIpc();
  win = new BrowserWindow({ show: false, width: 1024, height: 768, useContentSize: true, webPreferences: {
    preload: path.join(root, 'out/preload/index.js'), sandbox: true, contextIsolation: true, spellcheck: false,
    offscreen: true, backgroundThrottling: false,
  }});
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    requests.push(details.url); callback({ cancel: true });
  });
  const db = content.openContentDb();
  const query = "SELECT w.id,w.lemma,d.id AS lineId,d.text_en,we.surface FROM words w JOIN book_words bw ON bw.word_id=w.id JOIN word_examples we ON we.word_id=w.id AND we.rank=(SELECT min(first.rank) FROM word_examples first WHERE first.word_id=w.id) JOIN dialog_lines d ON d.id=we.line_id LEFT JOIN speakers s ON s.name=d.speaker WHERE bw.book_id=? AND ";
  const portrait = db.prepare(query + "s.image_kind='portrait' AND length(d.text_en) BETWEEN 80 AND 180 ORDER BY w.id LIMIT 1").get(bookId);
  const missing = db.prepare(query + "(s.image_kind IS NULL OR s.image_kind!='portrait') AND length(d.text_en) BETWEEN 80 AND 180 ORDER BY w.id LIMIT 1").get(bookId);
  const long = db.prepare(query + "s.image_kind='portrait' ORDER BY length(d.text_en) DESC LIMIT 1").get(bookId);
  const noExample = db.prepare('SELECT w.id,w.lemma FROM words w JOIN book_words bw ON bw.word_id=w.id WHERE bw.book_id=? AND NOT EXISTS(SELECT 1 FROM word_examples we WHERE we.word_id=w.id) ORDER BY w.id LIMIT 1').get(bookId);
  assert.equal(content.getWordExamples(missing.id)[0].portrait, null);
  async function reviewSample(sample) {
    progress.openProgressDb().prepare('DELETE FROM cards WHERE book_id=?').run(bookId);
    const row = study.ensureCard(sample.id, bookId);
    progress.upsertCard({ ...row, due: '2020-01-01T00:00:00.000Z', reps: 1, state: 2 });
    await open('/review', 'document.querySelector(".gw-word")?.textContent===' + JSON.stringify(sample.lemma));
    assert.equal(await evaluate('document.querySelectorAll(".gw-example-switch button").length'),0,'Examples must stay hidden before meaning reveal');
    await evaluate('document.querySelector("button[aria-expanded]").click()');
    await waitFor('!!document.querySelector(".gw-rate")');
    await waitFor('!!document.querySelector(".gw-review-art")?.naturalWidth');
    await delay(300);
  }
  await open('/', '!!document.querySelector(".gw-study-stats")');
  if (baseline) {
    await capture('home-1024');
    await reviewSample(portrait);
    await capture('review-1024');
    console.log(JSON.stringify({ ok: true, baseline: true, output }));
    return;
  }
  const sourceStart = portrait.text_en.toLowerCase().indexOf(portrait.surface.toLowerCase());
  const collected = collections.collectFromDialogue({ lineId: portrait.lineId, start: sourceStart, end: sourceStart + portrait.surface.length });
  study.reviewCard(collected.word.id, '__collection__', 3, 'ui-review-collection');
  for (const sample of [portrait, missing, long]) {
    const row = study.ensureCard(sample.id, bookId);
    progress.upsertCard({ ...row, reps: 1, state: 2 });
    const question = exercise.buildExercise(bookId, sample.id, 'spelling');
    const checked = exercise.submitExercise(question.id, Object.fromEntries(question.blanks.map(blank => [blank.id, content.getWord(sample.id).lemma])));
    assert.ok(checked.answers.every(answer => answer.correct), 'Reward sample must pass a real self-test');
  }
  const rewardCount = rewards.getRewards().history.length;
  assert.ok(rewardCount > 0, 'New reward ledger must contain genuine self-test awards');
  for (const [width, height] of [[1024, 768], [1024, 600], [1008, 730], [819, 600]]) {
    win.setContentSize(width, height);
    const size = width + 'x' + height;
    await open('/', '!!document.querySelector(".gw-study-stats")');
    await inspect('home-' + size, { capture: width === 1024 && height === 768 });
    for (const [label, sample, companion] of [['portrait', portrait, false], ['fallback', missing, true], ['long', long, false], ['no-example', noExample, true]]) {
      await reviewSample(sample);
      await inspect('review-' + label + '-' + size, { review: true, companion, long: label === 'long', capture: width === 1024 && height === 768 });
    }
    await open('/collection', '!!document.querySelector(".gw-collection-entry")');
    await inspect('collection-' + size, { capture: width === 1024 && height === 768 });
    progress.upsertCard({ ...progress.getCard(collected.word.id, '__collection__'), due: '2020-01-01T00:00:00.000Z' });
    await open('/review?scope=collection', '!!document.querySelector(".gw-word")');
    await evaluate('document.querySelector("button[aria-expanded]").click()');
    await waitFor('!!document.querySelector(".gw-review-art")?.naturalWidth');
    await delay(300);
    await inspect('review-collection-' + size, { review: true });
    await open('/practice?scope=collection', '!!document.querySelector(".gw-cloze input")');
    await inspect('practice-' + size, { capture: width === 1024 && height === 768 });
    await open('/browse', '!!document.querySelector(".gw-list-item")');
    await inspect('browse-' + size, { capture: width === 1024 && height === 768 });
    const source = collections.listCollection()[0].source;
    await open('/browse?chapterId=' + source.chapterId + '&questId=' + source.questId + '&lineId=' + source.lineId, '!!document.querySelector(".gw-source-line")');
    await inspect('dialogue-' + size);
    await open('/rewards', 'document.querySelectorAll(".gw-reward-entry").length===' + rewardCount);
    await inspect('rewards-' + size, { capture: width === 1024 && height === 768 });
    await open('/about', 'document.querySelectorAll("tbody tr").length>0');
    await inspect('about-' + size, { capture: width === 1024 && height === 768 });
  }
  // 读图失败也必须回退为荧，不保留破图或活动横图。
  const asset = context.load('assets');
  const originalAsset = asset.assetDataUrl;
  asset.assetDataUrl = (p, audio) => !audio && p.includes('/portrait/') ? null : originalAsset(p, audio);
  win.setContentSize(1024, 768);
  await reviewSample(portrait);
  await inspect('review-broken-image-1024x768', { review: true, companion: true });
  asset.assetDataUrl = originalAsset;

  // Every mode is selectable on Home and remains valid on reload.
  win.setContentSize(1024,600);
  await open('/', '!!document.querySelector("#study-size")');
  assert.deepEqual(await evaluate('Array.from(document.querySelector("#study-size").options,o=>o.value)'),['10','20','50','100','marathon']);
  await evaluate("(()=>{const el=document.querySelector('#study-size');el.value='20';el.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await waitFor("!document.querySelector('#study-size').disabled");
  assert.equal(progress.getSetting('studySize'),'20');
  await open('/', 'document.querySelector("#study-size")?.value==="20"');
  await inspect('home-size-persisted-1024x600',{capture:true});
  // Example tabs stay hidden until reveal; the selected source controls portrait and caption.
  const switchSample=db.prepare('SELECT w.id,w.lemma FROM words w JOIN book_words bw ON bw.word_id=w.id JOIN word_examples we ON we.word_id=w.id JOIN dialog_lines d ON d.id=we.line_id WHERE bw.book_id=? GROUP BY w.id HAVING count(DISTINCT d.speaker)>1 ORDER BY w.id LIMIT 200').all(bookId).find(word=>{const examples=content.getWordExamples(word.id);return examples.length===3&&new Set(examples.map(example=>example.portrait?.imagePath||'companion')).size>1;});
  assert.ok(switchSample,'Need a real word with three examples and different source portraits');
  await reviewSample(switchSample);
  const sourceExamples=content.getWordExamples(switchSample.id);
  const fIsTraveler=context.load('../shared/traveler').isTravelerSpeaker;
  for(const selected of [...sourceExamples.map((_,index)=>index),0]){
    const source=sourceExamples[selected];
    const protagonist=source.portrait?.traveler || fIsTraveler(source.portrait?.name);
    const expectedPath=protagonist?'bundled/lumine-companion.webp':source.portrait?.imagePath || 'bundled/lumine-companion.webp';
    if(sourceExamples.length>1)await evaluate('document.querySelectorAll(".gw-example-switch button")['+selected+'].click()');
    await waitFor('document.querySelector(".gw-review-art")?.getAttribute("data-portrait-path")==='+JSON.stringify(expectedPath)+'&&document.querySelector(".gw-review-art")?.naturalWidth>0');
    assert.equal(await evaluate('document.querySelector(".gw-portrait-name").textContent'),protagonist?'荧':source.portrait?.name||'荧');
    if(sourceExamples.length>1)assert.equal(await evaluate('document.querySelectorAll(".gw-example-switch button")['+selected+'].getAttribute("aria-pressed")'),'true');
    await inspect('review-example-switch-'+selected+'-1024x600',{review:true,capture:true});
  }
  // Marathon appends another batch instead of ending at twenty, and stops at the user's command.
  progress.openProgressDb().prepare('DELETE FROM cards WHERE book_id=?').run(bookId);
  progress.setSetting('studySize','marathon');
  await open('/review','!!document.querySelector(".gw-word")');
  const seen=[];
  for(let index=0;index<20;index++){
    await waitFor('!!document.querySelector(".gw-word") && !document.querySelector(".gw-rate button:disabled")');
    seen.push(await evaluate('document.querySelector(".gw-word").textContent'));
    await evaluate('document.querySelector("button[aria-expanded]").click()');
    await waitFor('!!document.querySelector(".gw-rate .good")');
    await evaluate('document.querySelector(".gw-rate .good").click()');
    await waitFor('document.body.innerText.includes('+JSON.stringify('马拉松 · 第 '+(index+2)+' 张')+')');
  }
  assert.equal(new Set(seen).size,20,'Marathon must advance through fresh cards');
  await evaluate('document.querySelector("button[aria-expanded]").click()');
  await waitFor('!!document.querySelector(".gw-rate")');
  await waitFor('!!document.querySelector(".gw-review-art")?.naturalWidth');
  await delay(800);
  await inspect('review-marathon-batch-two-1024x600',{review:true,capture:true});
  await evaluate('document.querySelector(".gw-stop-study").click()');
  await waitFor('!!document.querySelector(".gw-session-end")');
  assert.ok((await evaluate('document.body.innerText')).includes('已完成 20 次复习'));
  await inspect('review-marathon-stopped-1024x600',{capture:true});
  progress.setSetting('studySize','10');
  // Known commission variants have distinct labels and a true full-width 4:1 banner.
  await open('/browse?chapterId=25029','!!document.querySelector(".gw-cover")?.naturalWidth');
  await inspect('browse-commission-banner-1024x600',{capture:true});
  const banner=await evaluate("(()=>{const image=document.querySelector('.gw-cover');const box=image.getBoundingClientRect();return {width:box.width,height:box.height,container:image.parentElement.clientWidth};})()");
  assert.ok(Math.abs(banner.width/banner.height-4)<.02);
  assert.ok(Math.abs(banner.width-banner.container)<2);
  assert.ok((await evaluate('document.body.innerText')).includes('初次相遇'));

  // Voice headers use the named character's artwork and source-coordinate focus.
  for (const id of [-10000034, -10000102, -10000140, -10000005, -10000007]) {
    const chapter = content.getChapter(id);
    assert.equal(chapter.type, 'voice');
    assert.ok(['official_character_desktop_verified', 'same_character_portrait_fallback'].includes(chapter.cover_match));
    await open('/browse?chapterId=' + id, '!!document.querySelector(".gw-cover")?.naturalWidth');
    const actual = await evaluate("(()=>{const image=document.querySelector('.gw-cover'),box=image.getBoundingClientRect();return {width:box.width,height:box.height,container:image.parentElement.clientWidth,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,position:getComputedStyle(image).objectPosition};})()");
    const expected = context.load('../shared/cover-focus').coverObjectPosition(actual.naturalWidth, actual.naturalHeight, chapter.cover_focus);
    const percentages = actual.position.split(' ').map(parseFloat);
    assert.ok(Math.abs(actual.width / actual.height - 4) < .02);
    assert.ok(Math.abs(actual.width - actual.container) < 2);
    assert.ok(Math.abs(percentages[0] / 100 - expected.x) < .00001);
    assert.ok(Math.abs(percentages[1] / 100 - expected.y) < .00001);
    await inspect('browse-voice-' + chapter.title_en.toLowerCase().replace(/[^a-z]+/g, '-') + '-1024x600', {capture:true});
  }


  const {apiChannels}=context.load('../shared/ipc');
  const replaceHandler=(channel,handler)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,handler);};
  const settingChannel=apiChannels.getSetting,settingHandler=ipc.handlers[settingChannel];
  let failBootstrap=true;
  replaceHandler(settingChannel,(event,key,...args)=>{
    if(key==='currentBook'&&failBootstrap){failBootstrap=false;throw Error('模拟词书读取未完成');}
    return settingHandler(event,key,...args);
  });
  await open('/review','!!document.querySelector(".gw-study-error")');
  assert.ok((await evaluate('document.body.innerText')).includes('模拟词书读取未完成'));
  await inspect('review-bootstrap-retry-1024x600',{capture:true});
  await evaluate('document.querySelector(".gw-study-error .gw-btn").click()');
  await waitFor('!!document.querySelector(".gw-word")');
  replaceHandler(settingChannel,settingHandler);
  // Recover a failed second marathon batch without dropping progress or changing to due-only.
  const batchChannel=apiChannels.nextStudyBatch,batchHandler=ipc.handlers[batchChannel],batchCalls=[];
  replaceHandler(batchChannel,(event,book,request)=>{
    batchCalls.push(structuredClone(request));
    if(batchCalls.length===2)throw Error('模拟下一批词卡读取未完成');
    return batchHandler(event,book,request);
  });
  progress.openProgressDb().prepare('DELETE FROM cards WHERE book_id=?').run(bookId);
  progress.setSetting('studySize','marathon');
  await open('/review','!!document.querySelector(".gw-word")');
  for(let index=0;index<20;index++){
    await evaluate('document.querySelector("button[aria-expanded]").click()');
    await waitFor('!!document.querySelector(".gw-rate .good")');
    await evaluate('document.querySelector(".gw-rate .good").click()');
    if(index<19)await waitFor('document.body.innerText.includes('+JSON.stringify('马拉松 · 第 '+(index+2)+' 张')+')');
    else await waitFor('!!document.querySelector(".gw-study-error")');
  }
  await delay(800);
  await inspect('review-marathon-refill-error-1024x600',{capture:true});
  await evaluate('document.querySelector(".gw-study-error .gw-btn").click()');
  await waitFor('document.body.innerText.includes("马拉松 · 第 21 张")');
  assert.equal(batchCalls.length,3);
  assert.equal(batchCalls[2].dueOnly,false);
  assert.equal(batchCalls[2].excludeNewIds.length,20);
  await evaluate('document.querySelector(".gw-stop-study").click()');
  await waitFor('!!document.querySelector(".gw-session-end")');
  assert.ok((await evaluate('document.body.innerText')).includes('已完成 20 次复习'));
  replaceHandler(batchChannel,batchHandler);
  progress.setSetting('studySize','10');
  // A stored rating with a lost response can only be retried with the original choice.
  const rateChannel=apiChannels.rateReview,rateHandler=ipc.handlers[rateChannel];
  let loseRatingResponse=true,storedRating=null;
  replaceHandler(rateChannel,(event,...args)=>{
    const result=rateHandler(event,...args);
    storedRating=args;
    if(loseRatingResponse){loseRatingResponse=false;throw Error('模拟评分响应未确认');}
    return result;
  });
  progress.openProgressDb().prepare('DELETE FROM cards WHERE book_id=?').run(bookId);
  await open('/review','!!document.querySelector(".gw-word")');
  await evaluate('document.querySelector("button[aria-expanded]").click()');
  await waitFor('!!document.querySelector(".gw-rate .good")');
  await evaluate('document.querySelector(".gw-rate .good").click()');
  await waitFor('document.body.innerText.includes("模拟评分响应未确认")');
  await delay(800);
  assert.equal(await evaluate('document.querySelectorAll(".gw-rate button:not(:disabled)").length'),1);
  assert.equal(await evaluate('document.querySelector(".gw-rate button:not(:disabled)").className'),'good');
  const savedCard=progress.getCard(storedRating[0],bookId);
  await inspect('review-rating-response-retry-1024x600',{review:true,capture:true});
  await evaluate('document.querySelector(".gw-rate .good").click()');
  await waitFor('document.body.innerText.includes("2 / 10")');
  assert.equal(progress.getCard(storedRating[0],bookId).reps,savedCard.reps);
  assert.equal(progress.getCard(storedRating[0],bookId).due,savedCard.due);
  replaceHandler(rateChannel,rateHandler);

  assert.deepEqual(errors, [], 'Renderer console errors');
  assert.deepEqual(requests, [], 'Runtime attempted a network request');
  const report = { ok: true, cases: results.length, minContrast: Math.min(...results.map(r => r.minContrast)), errors, requests, results };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (fs.existsSync(path.join(output, 'failure.json'))) fs.unlinkSync(path.join(output, 'failure.json'));
  console.log(JSON.stringify({ ok: true, cases: report.cases, minContrast: report.minContrast, output }));
})().then(() => finish(0), e => {
  if (output) { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: e.message, results, errors }, null, 2), 'utf8'); }
  console.error(e); finish(1);
});
function finish(code) { win?.destroy(); context?.close(); app.exit(code); }
