const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { loadMain, root } = require('../helpers/load-main.cjs');

const output = process.argv[3];
const measurements = [], errors = [], requests = [];
let win, context, pageRun = 0;
app.setPath('userData', process.argv[2]);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});
const evaluate = code => win.webContents.executeJavaScript(code, true);

async function waitFor(code) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await evaluate(code)) return;
    await delay(60);
  }
  throw Error('UI timeout: ' + code + '\n' + await evaluate('document.body.innerText'));
}
async function open(hash, ready) {
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { hash, query: { readingAuditRun: String(++pageRun) } });
  await waitFor(ready);
  await evaluate('document.fonts.ready');
  await delay(850);
}
async function click(label) {
  const expected = JSON.stringify(label);
  await waitFor(`Array.from(document.querySelectorAll('a,button')).some(el=>el.textContent.trim()===${expected}&&!el.disabled)`);
  await evaluate(`Array.from(document.querySelectorAll('a,button')).find(el=>el.textContent.trim()===${expected}&&!el.disabled).click()`);
}
async function capture(name, target) {
  if (target) await evaluate(`document.getElementById(${JSON.stringify(target)})?.scrollIntoView({block:'start'})`);
  await delay(180);
  win.webContents.invalidate();
  await delay(120);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
function measurePage() {
  function rgba(value) {
    const values = value.match(/[\d.]+/g)?.map(Number);
    return values ? [values[0], values[1], values[2], values.length > 3 ? values[3] : 1] : [0, 0, 0, 0];
  }
  function over(fg, bg) { return fg.slice(0, 3).map((value, index) => value * fg[3] + bg[index] * (1 - fg[3])).concat(1); }
  function background(element) {
    const own = rgba(getComputedStyle(element).backgroundColor);
    return own[3] === 1 ? own : over(own, element.parentElement ? background(element.parentElement) : [255, 255, 255, 1]);
  }
  function luminance(color) {
    return color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  }
  function contrast(fg, bg) { const a = luminance(fg), b = luminance(bg); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); }
  const lowContrast = [], overflow = [], text = [];
  for (const element of document.querySelectorAll('body *')) {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (!rect.width || !rect.height || style.visibility !== 'visible' || style.display === 'none') continue;
    if (rect.left < -1 || rect.right > innerWidth + 1) overflow.push({ tag: element.tagName, class: element.className, left: rect.left, right: rect.right });
    const ownText = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
    if (!/\p{L}|\p{N}/u.test(ownText) || element.matches(':disabled') || element.closest('select,[aria-hidden="true"]')) continue;
    const bg = background(element), fg = rgba(style.color);
    let opacity = 1;
    for (let parent = element; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity);
    fg[3] *= opacity;
    const ratio = contrast(over(fg, bg), bg);
    const entry = { text: ownText.slice(0, 60), ratio: Math.round(ratio * 100) / 100, size: style.fontSize };
    text.push(entry);
    if (ratio < 4.5) lowContrast.push(entry);
  }
  for (const element of document.querySelectorAll('input:not([type="radio"]),select')) {
    if (element.disabled || !element.getBoundingClientRect().width) continue;
    const style = getComputedStyle(element), bg = background(element);
    const ratio = contrast(over(rgba(style.color), bg), bg);
    if (ratio < 4.5) lowContrast.push({ text: element.value, ratio, size: style.fontSize });
  }
  const banner = document.querySelector('img.rd-banner');
  const box = banner?.getBoundingClientRect();
  return {
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
    overflow: overflow.slice(0, 12), lowContrast, minContrast: Math.min(...text.map(item => item.ratio)),
    fontLoaded: document.fonts.check('500 20px "Noto Serif SC"', '提瓦特荧'),
    banner: banner ? { width: banner.naturalWidth, height: banner.naturalHeight, displayedRatio: box.width / box.height } : null,
  };
}
async function inspect(name, banner = false) {
  await delay(650);
  const measured = await evaluate('(' + measurePage.toString() + ')()');
  measurements.push({ name, ...measured });
  assert.ok(measured.scrollWidth <= measured.clientWidth + 1, name + ': page horizontal overflow');
  assert.deepEqual(measured.overflow, [], name + ': element horizontal overflow');
  assert.deepEqual(measured.lowContrast, [], name + ': text contrast below 4.5:1');
  assert.equal(measured.fontLoaded, true, name + ': bundled font missing');
  if (banner) {
    assert.equal(measured.banner?.width, 1600, name + ': real local banner missing');
    assert.equal(measured.banner.height, 400, name + ': source banner is not 4:1');
    assert.ok(Math.abs(measured.banner.displayedRatio - 4) < .025, name + ': displayed banner is not 4:1');
  }
}
async function choose(question, answer) {
  const form = JSON.stringify('reading-q-' + question.id), value = JSON.stringify(answer);
  await evaluate(`(()=>{const form=document.getElementById(${form});const select=form.querySelector('select');if(select){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${value});select.dispatchEvent(new Event('change',{bubbles:true}));return;}const radio=Array.from(form.querySelectorAll('input[type="radio"]')).find(input=>input.value===${value});if(radio){radio.click();return;}const input=form.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${value});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}

async function submitPaper() {
  await click('交卷，看看答得怎么样');
  await waitFor('!!document.querySelector(".rd-celebration")||!!document.querySelector(".rd-paper-score")');
}
async function dismissCelebration() {
  if (await evaluate('!!document.querySelector(".rd-celebration")')) {
    await click('收好啦！');
    await waitFor('!document.querySelector(".rd-celebration")');
  }
}
async function fillPaper(unit, wrongId) {
  for (const question of unit.questions) {
    const answer = question.id === wrongId
      ? question.options.find(option => option.id !== question.expected).id : question.expected;
    await choose(question, answer);
  }
}
async function currentAnswers() {
  return evaluate('Object.fromEntries(Array.from(document.querySelectorAll(".rd-question")).map(section=>[section.id.slice("reading-q-".length),section.querySelector("select")?.value||section.querySelector("input[type=radio]:checked")?.value||section.querySelector("input:not([type=radio])")?.value||""]))');
}
async function press(keyCode) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await delay(70);
}
async function openBilingualWord(paragraph, tokenIndex) {
  await evaluate('(()=>{const section=document.getElementById(' + JSON.stringify('reading-bilingual-' + paragraph.unitId + '-' + paragraph.paragraph) + ');const token=section.querySelectorAll(".gw-token")[' + tokenIndex + '];token.scrollIntoView({block:"center"});window.auditWordToken=token;token.click();})()');
  await waitFor('!!document.querySelector(".rd-word-popup")&&!document.querySelector(".rd-word-popup")?.textContent.includes("派蒙翻翻词典")');
}

(async () => {
  await app.whenReady();
  fs.mkdirSync(output, { recursive: true });
  context = loadMain(path.join(root, 'content/content.db'), path.join(process.argv[2], 'progress.db'));
  const content = context.load('content-db'), progress = context.load('progress-db'), study = context.load('study');
  const reading = context.load('reading'), rewards = context.load('rewards'), collections = context.load('collections');
  const wordTokens = context.load('../shared/text').wordTokens;
  const bank = context.load('reading-bank').READING_BANK;
  assert.ok(bank.length >= 69, 'All migrated independent practices must remain in the catalog');
  assert.ok(bank.every(unit => !unit.paper || unit.paper.passages.length === 1), 'A learning unit must contain exactly one passage');
  const automaticAnimationUnit = bank.find(unit => unit.level === 'cet4').id;
  const reducedMotionUnit = bank.find(unit => unit.level === 'cet6').id;
  const bookId = content.listBooks().find(book => /sh.*zhong|shanghai|zhongkao/.test(book.id))?.id || content.listBooks()[0].id;
  progress.setSetting('currentBook', bookId);
  progress.setSetting('traveler', 'lumine');
  const sample = content.openContentDb().prepare('SELECT w.id,w.lemma FROM words w JOIN book_words bw ON bw.word_id=w.id WHERE bw.book_id=? AND length(w.lemma) BETWEEN 5 AND 10 AND length(w.translation) BETWEEN 8 AND 90 ORDER BY w.id LIMIT 1').get(bookId);
  assert.ok(sample, 'Need one real vocabulary word');
  study.reviewCard(sample.id, bookId, 3, 'ui-reading-word-study');
  assert.equal(rewards.getRewards().total, 0);
  context.load('ipc').registerIpc();
  win = new BrowserWindow({ show: false, width: 1024, height: 768, useContentSize: true, webPreferences: {
    preload: path.join(root, 'out/preload/index.js'), sandbox: true, contextIsolation: true, spellcheck: false,
    offscreen: true, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    requests.push(details.url); callback({ cancel: true });
  });

  await open('/reading', '!!document.querySelector(".rd-unit-card")');
  assert.equal(await evaluate('document.querySelector(".gw-hero-title").textContent'), '提瓦特大陆有太多故事');
  assert.equal(await evaluate('document.querySelector(".rd-intro").textContent'), '背单词累了吗？来读读故事吧，答对题有奖励哦。');
  assert.ok((await evaluate('document.querySelector(".rd-catalog-heading").innerText')).includes('上海中考'));
  await inspect('reading-catalog-1024x768');
  await capture('reading-catalog-1024x768');
  assert.equal(await evaluate('document.querySelectorAll(".rd-unit-card").length'), bank.filter(unit => unit.level === 'sh_zhongkao').length);
  assert.ok(!/整卷|整套阅读|套卷|试卷|卷内篇目/.test(await evaluate('document.body.innerText')), 'Catalog should describe independent stories');

  const entry = bank.find(unit => unit.level === 'entry');
  const middle = bank.find(unit => unit.level === 'sh_zhongkao' && !unit.paper);
  const nativeSaveDialog = dialog.showSaveDialog;
  await open('/reading?unitId=' + entry.id, '!!document.querySelector("img.rd-banner")?.naturalWidth');
  dialog.showSaveDialog = async () => ({ canceled: true });
  await click('保存题目与解析 PDF');
  await waitFor('document.querySelector(".rd-notice")?.textContent.includes("取消")');
  assert.equal(reading.getReadingUnit(entry.id).answersViewed, false);
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(output, 'reading-ui-export.pdf') });
  await click('保存题目与解析 PDF');
  await waitFor('document.querySelector(".rd-notice")?.textContent.includes("热身")');
  assert.equal(reading.getReadingUnit(entry.id).answersViewed, true);
  assert.equal(await evaluate('!!document.getElementById("reading-analysis")'), false, 'PDF must not open web answers before paper submission');
  assert.equal(await evaluate('Array.from(document.querySelectorAll(".rd-question fieldset")).some(el=>el.disabled)'), false, 'PDF may still be used for a practice score');
  dialog.showSaveDialog = nativeSaveDialog;
  await fillPaper(entry);
  await submitPaper();
  await waitFor('!!document.querySelector(".rd-bilingual-paragraph")');
  assert.equal(await evaluate('!!document.querySelector(".rd-celebration")'), false, 'An assisted paper must not award gems');
  assert.equal(reading.getReadingUnit(entry.id).paperResult.score, entry.questions.length);
  assert.equal(rewards.getRewards().total, 0);
  await click('再读再答一次');
  await waitFor('!!document.querySelector("#reading-questions button[type=submit]")');

  const independentPair = bank.filter(unit => unit.level === 'sh_gaokao' && unit.paper).slice(0, 2);
  assert.equal(independentPair.length, 2);
  const [practiceA, practiceB] = independentPair;
  await open('/reading?unitId=' + practiceA.id, '!!document.querySelector(".rd-question")');
  await choose(practiceA.questions[0], practiceA.questions[0].expected);
  await delay(900);
  const draftA = reading.getReadingUnit(practiceA.id);
  await click('← 返回故事目录');
  await waitFor('!!document.querySelector(".rd-unit-card")');
  await open('/reading?unitId=' + practiceB.id, '!!document.querySelector(".rd-question")');
  assert.equal(reading.getReadingUnit(practiceB.id).paperResult, null);
  assert.ok(!Object.keys(await currentAnswers()).some(id => id in draftA.answers), 'Another reading must not show the first reading questions');
  await choose(practiceB.questions[0], practiceB.questions[0].expected);
  await delay(900);
  await open('/reading?unitId=' + practiceA.id, '!!document.querySelector(".rd-question")');
  assert.deepEqual(await currentAnswers(), Object.fromEntries(practiceA.questions.map(question => [question.id, draftA.answers[question.id] || ''])), 'Each reading must resume its own draft');
  assert.equal(rewards.getRewards().total, 0, 'Saving independent drafts must not award gems');

  const wrongQuestion = middle.questions[0].id;
  let sawResumedAnimation = false;
  for (const unit of bank) {
    await open('/reading?unitId=' + unit.id, '!!document.querySelector("img.rd-banner")?.naturalWidth');
    const source = reading.getReadingUnit(unit.id);
    const displayed = await evaluate('Array.from(document.querySelectorAll(".rd-paragraph p")).map(el=>{const copy=el.cloneNode(true);copy.querySelectorAll(".rd-inline-note").forEach(note=>note.remove());return copy.textContent;})');
    assert.deepEqual(displayed, source.paragraphs, unit.id + ': source text changed');
    const pageText = await evaluate('document.body.innerText');
    assert.ok((source.sections?.length ?? 1) <= 1, unit.id + ': only one passage per page');
    assert.equal(await evaluate('document.querySelectorAll(".rd-question").length'), unit.questions.length, unit.id + ': only this reading questions are displayed');
    for (const phrase of ['整卷', '整套阅读', '套卷', '试卷', '卷内篇目', '首答', '纠错后通过', '逐题检查', '试行篇目', '历史首答', '本篇已领取']) assert.ok(!pageText.includes(phrase), 'Old display remains: ' + phrase);
    assert.equal(await evaluate('document.querySelectorAll("#reading-questions button[type=submit]").length'), 1);
    assert.equal(await evaluate('document.querySelectorAll(".rd-question button").length'), 0, 'Question cards must not check or hint individually');
    const notes = await evaluate('Array.from(document.querySelectorAll(".rd-prose .rd-inline-note")).map(el=>el.textContent).join(" ")');
    for (const term of unit.glossary.filter(item => item.kind === 'genshin')) assert.ok(!notes.includes(term.explanation), 'Proper name explained before answering');
    await inspect('reading-' + unit.id + '-1024x768', true);
    await capture('reading-' + unit.id + '-1024x768', 'reading-passage');
    win.setContentSize(1024, 600);
    await inspect('reading-' + unit.id + '-1024x600', true);
    win.setContentSize(1024, 768);

    if (unit.id === middle.id) {
      const partial = {};
      for (const question of unit.questions.slice(0, 2)) { await choose(question, question.expected); partial[question.id] = question.expected; }
      await delay(900);
      assert.deepEqual(reading.getReadingUnit(unit.id).answers, partial, 'Draft must persist without grading');
      assert.equal(reading.getReadingUnit(unit.id).paperResult, null);
      const gemsBeforeDraftReload = rewards.getRewards().total;
      await open('/reading?unitId=' + unit.id, '!!document.querySelector(".rd-question input:checked")');
      assert.equal(await evaluate('document.querySelectorAll(".rd-question input:checked").length'), 2, 'Draft must restore selected answers');
      assert.equal(rewards.getRewards().total, gemsBeforeDraftReload);
    }
    const beforeSubmit = rewards.getRewards().total;
    await fillPaper(unit, unit.id === middle.id ? wrongQuestion : undefined);
    assert.equal(rewards.getRewards().total, beforeSubmit, 'Choosing answers must not award per question');
    if (unit.id === middle.id) {
      const intended = await currentAnswers();
      const originalSubmit = reading.submitReadingPaper, originalDraft = reading.saveReadingDraft;
      reading.submitReadingPaper = () => { throw Error('Injected failure before paper persistence'); };
      reading.saveReadingDraft = () => { throw Error('Injected failure before draft persistence'); };
      await click('交卷，看看答得怎么样');
      await waitFor('document.querySelector(".gw-error")?.textContent.includes("再交一次")&&!document.querySelector("#reading-questions button[type=submit]").disabled');
      assert.deepEqual(await currentAnswers(), intended, 'Failed submission must keep unsaved current answers rather than old stored draft');
      await click('保存题目与解析 PDF');
      await waitFor('document.querySelector(".gw-error")?.textContent.includes("再试一次")&&!document.querySelector("#reading-questions button[type=submit]").disabled');
      assert.deepEqual(await currentAnswers(), intended, 'Failed export must keep unsaved current answers');
      assert.equal(rewards.getRewards().total, beforeSubmit);
      reading.submitReadingPaper = originalSubmit; reading.saveReadingDraft = originalDraft;
    }
    if (unit.id === reducedMotionUnit) {
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    }
    if (unit.id === entry.id) {
      const originalSubmit = reading.submitReadingPaper;
      let releaseSubmit;
      reading.submitReadingPaper = (...args) => new Promise((resolve, reject) => {
        releaseSubmit = () => { try { resolve(originalSubmit(...args)); } catch (error) { reject(error); } };
      });
      await click('交卷，看看答得怎么样');
      for (let retry = 0; !releaseSubmit && retry < 100; retry++) await delay(10);
      assert.ok(releaseSubmit, 'Need in-flight paper submission');
      await evaluate('document.querySelector(".gw-traveler-toggle").click()');
      await waitFor('!!document.querySelector(".gw-traveler-picker")');
      reading.submitReadingPaper = originalSubmit; releaseSubmit();
      await waitFor('!!document.querySelector(".rd-paper-score")');
      await delay(4100);
      assert.equal(await evaluate('!!document.querySelector(".rd-celebration")'), false, 'Reward must wait behind traveler picker');
      assert.equal(reading.getReadingUnit(unit.id).paperResult.rewardAnimationPending, true, 'Hidden reward must not be acknowledged');
      await evaluate('Array.from(document.querySelectorAll(".gw-traveler-picker button")).at(-1).focus()');
      await press('Tab');
      assert.equal(await evaluate('document.activeElement===document.querySelector(".gw-traveler-picker button")'), true, 'Traveler picker must retain its Tab cycle');
      await press('Escape');
      await waitFor('!document.querySelector(".gw-traveler-picker")&&!!document.querySelector(".rd-celebration")');
      await delay(60);
      assert.equal(await evaluate('!!document.activeElement?.closest(".rd-celebration")'), true, 'Delayed picker focus restoration must not steal reward dialog focus');
    } else await submitPaper();
    await waitFor('!!document.querySelector(".rd-celebration")');
    const scored = reading.getReadingUnit(unit.id).paperResult;
    assert.equal(scored.score, unit.questions.length - (unit.id === middle.id ? 1 : 0));
    assert.equal(scored.maxScore, unit.questions.length);
    assert.equal(scored.rewardAnimationPending, true);
    assert.equal(await evaluate('document.querySelectorAll("#reading-questions button[type=submit]").length'), 0);
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".rd-question fieldset")).every(el=>el.disabled)'), true);

    if (unit.id === middle.id) {
      await open('/reading?unitId=' + unit.id, '!!document.querySelector(".rd-celebration")');
      assert.equal(reading.getReadingUnit(unit.id).paperResult.rewardAnimationPending, true, 'Pending reward animation must survive reload');
      sawResumedAnimation = true;
      await inspect('reading-paper-reward-1024x768', true);
      await capture('reading-paper-reward-1024x768');
      win.setContentSize(1024, 600);
      await inspect('reading-paper-reward-1024x600', true);
      await capture('reading-paper-reward-1024x600');
      win.setContentSize(1024, 768);
      await dismissCelebration();
      assert.equal(reading.getReadingUnit(unit.id).paperResult.rewardAnimationPending, false);
    } else if (unit.id === automaticAnimationUnit) {
      await waitFor('!document.querySelector(".rd-celebration")');
      assert.equal(reading.getReadingUnit(unit.id).paperResult.rewardAnimationPending, false, 'Animation end must acknowledge display');
    } else if (unit.id === reducedMotionUnit) {
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".rd-reward-paimon")).animationName'), 'none');
      await dismissCelebration();
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      win.webContents.debugger.detach();
    } else await dismissCelebration();
    await waitFor('!!document.querySelector(".rd-bilingual-paragraph")');
    assert.equal(await evaluate('document.querySelector(".rd-paper-score").textContent.trim()'), scored.score + ' / ' + scored.maxScore);
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".rd-analysis h3")).some(el=>el.textContent==="单词解释")'), true);
    assert.equal(await evaluate('document.querySelectorAll(".rd-bilingual-paragraph").length'), source.paragraphs.length);
    await inspect('reading-analysis-' + unit.id + '-1024x768', true);
    if (unit.id === middle.id || unit.level === 'cet6') await capture('reading-analysis-' + unit.id + '-1024x768', 'reading-analysis');
    win.setContentSize(1024, 600);
    await inspect('reading-analysis-' + unit.id + '-1024x600', true);
    if (unit.id === middle.id) await capture('reading-analysis-' + unit.id + '-1024x600', 'reading-analysis');
    win.setContentSize(1024, 768);
  }
  assert.equal(sawResumedAnimation, true);

  const legacyDefinition = context.load('reading-bank').LEGACY_READING_BANK.find(unit => unit.level === 'sh_gaokao');
  const legacyTarget = legacyDefinition.paper.passages.at(-1);
  const legacyOffset = legacyDefinition.paper.passages.slice(0, -1).reduce((sum, passage) => sum + passage.paragraphMap.length, 0);
  const gemsBeforeLegacyLink = rewards.getRewards().total;
  await open('/reading?unitId=' + legacyDefinition.id + '&questionId=' + legacyTarget.questions[0].id, '!!document.querySelector(".rd-bilingual-paragraph")');
  assert.ok((await evaluate('location.hash')).includes('unitId=' + legacyTarget.id), 'An old question link should resolve to the matching independent reading');
  assert.equal(await evaluate('document.querySelectorAll(".rd-question").length'), legacyTarget.questions.length);
  await open('/reading?unitId=' + legacyDefinition.id + '&paragraph=' + (legacyOffset + 1), '!!document.getElementById(' + JSON.stringify('reading-bilingual-' + legacyTarget.id + '-1') + ')');
  assert.ok((await evaluate('location.hash')).includes('paragraph=1'), 'Old global paragraph must resolve to local paragraph one');
  assert.equal(rewards.getRewards().total, gemsBeforeLegacyLink, 'Opening historical source links must not create rewards');
  await inspect('legacy-reading-location-1024x768', true);

  await open('/reading?unitId=' + middle.id, '!!document.querySelector(".rd-bilingual-paragraph")');
  assert.equal(await evaluate('!!document.querySelector(".rd-celebration")'), false, 'Acknowledged animation must not replay');
  assert.equal(await evaluate('document.querySelectorAll(".rd-verdict-wrong").length'), 1);
  await click('再读再答一次');
  await waitFor('!!document.querySelector("#reading-questions button[type=submit]")');
  await fillPaper(middle);
  const beforeSecondPaper = rewards.getRewards().total;
  await submitPaper();
  await waitFor('!!document.querySelector(".rd-celebration")');
  assert.equal(reading.getReadingUnit(middle.id).paperResult.earnedCount, 1, 'New round should award only previously incorrect item');
  assert.equal(rewards.getRewards().total, beforeSecondPaper + 1);
  await dismissCelebration();
  await waitFor('!!document.querySelector(".rd-bilingual-paragraph")');

  const bilingual = reading.getReadingAnalysis(reading.getReadingUnit(middle.id).attemptId).bilingualParagraphs;
  const candidates = [];
  for (const paragraph of bilingual) {
    const tokens = wordTokens(paragraph.textEn);
    for (const [tokenIndex, token] of tokens.entries()) {
      const word = content.lookupWordByLemma(token.text);
      if (word) candidates.push({ ...token, tokenIndex, word, paragraph: paragraph.paragraph, unitId: middle.id });
    }
  }
  const first = candidates.find(candidate => candidates.some(other => other.word.id === candidate.word.id && other.paragraph !== candidate.paragraph));
  assert.ok(first, 'Need a real local word in two source paragraphs');
  const repeated = candidates.find(candidate => candidate.word.id === first.word.id && candidate.paragraph !== first.paragraph);
  assert.ok(first && repeated, 'Need a real local word in two source paragraphs');
  await openBilingualWord(first, first.tokenIndex);
  await evaluate('(()=>{const event=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});event.preventDefault();document.dispatchEvent(event);})()');
  assert.equal(await evaluate('!!document.querySelector(".rd-word-popup")'), true, 'Already handled keys must not close word popup');
  await evaluate('document.querySelector(".gw-traveler-toggle").click()');
  await waitFor('!!document.querySelector(".gw-traveler-picker")');
  await evaluate('Array.from(document.querySelectorAll(".gw-traveler-picker button")).at(-1).focus()');
  await press('Tab');
  assert.equal(await evaluate('document.activeElement===document.querySelector(".gw-traveler-picker button")'), true);
  await press('Escape');
  await waitFor('!document.querySelector(".gw-traveler-picker")');
  assert.equal(await evaluate('!!document.querySelector(".rd-word-popup")'), true, 'Underlying word popup must ignore keys handled by the picker');
  await inspect('reading-word-popup-1024x768', true);
  await capture('reading-word-popup-1024x768');
  await click('加入收藏词表');
  await waitFor('document.querySelector(".rd-word-popup")?.textContent.includes("一起放进收藏词表")');
  const originalCollection = collections.listCollection().find(item => item.word.id === first.word.id);
  assert.equal(originalCollection.source.origin, 'reading');
  assert.equal(originalCollection.source.text.slice(originalCollection.source.start, originalCollection.source.end), first.text);
  const savedSource = JSON.stringify(originalCollection.source);
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await waitFor('!document.querySelector(".rd-word-popup")');
  assert.equal(await evaluate('document.activeElement===window.auditWordToken'), true, 'Popup close must restore keyboard focus');
  await openBilingualWord(repeated, repeated.tokenIndex);
  await click('加入收藏词表');
  await waitFor('document.querySelector(".rd-word-popup")?.textContent.includes("已经在收藏里")');
  assert.equal(JSON.stringify(collections.listCollection().find(item => item.word.id === first.word.id).source), savedSource, 'Repeated collection must keep original sentence');
  win.setContentSize(1024, 600);
  await inspect('reading-word-popup-1024x600', true);
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await waitFor('!document.querySelector(".rd-word-popup")');
  const unknownParagraph = bilingual.find(paragraph => wordTokens(paragraph.textEn).some(token => !content.lookupWordByLemma(token.text)));
  if (unknownParagraph) {
    const index = wordTokens(unknownParagraph.textEn).findIndex(token => !content.lookupWordByLemma(token.text));
    await openBilingualWord({ unitId: middle.id, paragraph: unknownParagraph.paragraph }, index);
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".rd-word-popup button")).some(el=>el.textContent==="加入收藏词表")'), false);
    await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  }
  await open('/collection', '!!document.querySelector(".gw-collection-entry")');
  await click('回到故事原文');
  await waitFor('!!document.getElementById(' + JSON.stringify('reading-bilingual-' + middle.id + '-' + originalCollection.source.paragraph) + ')');
  await delay(350);
  assert.equal(await evaluate('(()=>{const el=document.getElementById(' + JSON.stringify('reading-bilingual-' + middle.id + '-' + originalCollection.source.paragraph) + ');const rect=el.getBoundingClientRect();return el.classList.contains("rd-paragraph-highlight")&&rect.top<innerHeight&&rect.bottom>0;})()'), true, 'Collection source link should locate the bilingual paragraph');
  await inspect('collection-reading-source-1024x600', true);
  await click('再读再答一次');
  await waitFor('!!document.querySelector("#reading-questions button[type=submit]")');
  await open('/collection', '!!document.querySelector(".gw-collection-entry")');
  await click('回到故事原文');
  await waitFor('!!document.getElementById(' + JSON.stringify('reading-bilingual-' + middle.id + '-' + originalCollection.source.paragraph) + ')');
  await delay(350);
  assert.equal(await evaluate('!!document.querySelector(".rd-bilingual-paragraph")'), true, 'A collection source must restore its original answered round');
  assert.equal(await evaluate('new URLSearchParams(location.hash.split("?")[1]).get("attemptId")'), originalCollection.source.attemptId);
  assert.equal(await evaluate('(()=>{const el=document.getElementById(' + JSON.stringify('reading-bilingual-' + middle.id + '-' + originalCollection.source.paragraph) + ');const rect=el.getBoundingClientRect();return el.classList.contains("rd-paragraph-highlight")&&rect.top<innerHeight&&rect.bottom>0;})()'), true, 'Historical source link should locate its original bilingual paragraph');
  await inspect('collection-reading-historical-source-1024x600', true);
  await open('/reading?unitId=' + middle.id, '!!document.querySelector("#reading-questions button[type=submit]")&&!document.querySelector(".rd-bilingual-paragraph")');
  assert.notEqual(reading.getReadingUnit(middle.id).attemptId,originalCollection.source.attemptId,'Opening a historical source must not replace the current draft');
  const originalDraftSave = reading.saveReadingDraft, heldSaves = [];
  const activeDraft = reading.getReadingUnit(middle.id);
  reading.saveReadingDraft = (...args) => args[0] === activeDraft.attemptId
    ? new Promise((resolve, reject) => heldSaves.push(() => { try { resolve(originalDraftSave(...args)); } catch (error) { reject(error); } }))
    : originalDraftSave(...args);
  await choose(middle.questions[0], middle.questions[0].expected);
  await click('← 返回故事目录');
  for (let retry = 0; !heldSaves.length && retry < 100; retry++) await delay(10);
  assert.ok(heldSaves.length, 'Need an in-flight draft save before navigation');
  await evaluate('Array.from(document.querySelectorAll(".gw-nav a")).find(el=>el.textContent.trim()==="单词自测").click()');
  await waitFor('location.hash.startsWith("#/practice")');
  reading.saveReadingDraft = originalDraftSave;
  for (const release of heldSaves) release();
  await delay(400);
  assert.equal(await evaluate('location.hash.startsWith("#/practice")'), true, 'Late directory save must not pull user back after leaving');
  win.setContentSize(1024, 768);

  const readingTotal = bank.reduce((sum, unit) => sum + unit.questions.length, 0);
  assert.equal(rewards.getRewards().readingTotal, readingTotal);
  await open('/practice?bookId=' + encodeURIComponent(bookId) + '&wordId=' + sample.id, '!!document.querySelector(".gw-selftest-options")');
  await inspect('word-recognition-1024x768');
  await capture('word-recognition-1024x768');
  const stored = JSON.parse(progress.openProgressDb().prepare('SELECT payload_json FROM exercise_attempts ORDER BY rowid DESC LIMIT 1').get().payload_json);
  const correctId = stored.solutions[0].accepted[0];
  await evaluate('Array.from(document.querySelectorAll(".gw-selftest-options input")).find(el=>el.value===' + JSON.stringify(correctId) + ').click()');
  await click('检查答案');
  await waitFor('document.querySelector(".gw-practice-result")?.textContent.includes("获得 1 原石")');
  assert.equal(rewards.getRewards().wordTotal, 1);
  for (const height of [768, 600]) {
    win.setContentSize(1024, height);
    await open('/rewards', 'document.querySelectorAll(".gw-reward-entry").length>0');
    await inspect('global-rewards-1024x' + height);
    if (height === 768) await capture('global-rewards-1024x768');
  }
  await evaluate('(()=>{const select=document.querySelector(".gw-browse-filters select");Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(select,"reading");select.dispatchEvent(new Event("change",{bubbles:true}));})()');
  const deepQuestion = bank.find(unit => unit.level === 'cet6').questions.at(-1);
  await waitFor('document.body.innerText.includes(' + JSON.stringify('当前筛选：' + readingTotal + ' 笔') + ')');
  assert.ok(await evaluate('document.querySelectorAll(".gw-reward-entry").length>0&&document.querySelectorAll(".gw-reward-entry").length<=' + readingTotal));
  await evaluate('(()=>{const field=document.querySelector(".gw-browse-filters input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(field,' + JSON.stringify(deepQuestion.prompt) + ');field.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await waitFor('Array.from(document.querySelectorAll(".gw-reward-entry a")).some(el=>el.getAttribute("href").includes(' + JSON.stringify('questionId=' + encodeURIComponent(deepQuestion.id)) + '))');
  await evaluate('Array.from(document.querySelectorAll(".gw-reward-entry a")).find(el=>el.getAttribute("href").includes(' + JSON.stringify('questionId=' + encodeURIComponent(deepQuestion.id)) + ')).click()');
  await waitFor('!!document.getElementById(' + JSON.stringify('reading-analysis-q-' + deepQuestion.id) + ')');
  await delay(850);
  assert.equal(await evaluate('(()=>{const rect=document.getElementById(' + JSON.stringify('reading-analysis-q-' + deepQuestion.id) + ').getBoundingClientRect();return rect.top<innerHeight&&rect.bottom>0;})()'), true);
  await inspect('reward-reading-source-link-1024x600', true);
  assert.equal(rewards.getRewards().total, readingTotal + 1);
  assert.deepEqual(errors, [], 'Renderer console errors');
  assert.deepEqual(requests, [], 'Offline runtime attempted a network request');
  const report = { ok: true, cases: measurements.length, readingQuestions: readingTotal, totalGems: rewards.getRewards().total,
    minContrast: Math.min(...measurements.map(item => item.minContrast)), errors, requests, measurements };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (fs.existsSync(path.join(output, 'failure.json'))) fs.unlinkSync(path.join(output, 'failure.json'));
  console.log(JSON.stringify({ ok: true, cases: report.cases, readingQuestions: readingTotal, minContrast: report.minContrast, output }));
})().then(() => finish(0), error => {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, measurements, errors, requests }, null, 2), 'utf8');
  console.error(error); finish(1);
});
function finish(code) { win?.destroy(); context?.close(); app.exit(code); }
