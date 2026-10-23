const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { app, BrowserWindow, dialog } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { loadMain, root } = require('../helpers/load-main.cjs');

const profile = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]), phase = process.argv[4];
assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
assert.ok(path.basename(profile).startsWith('genshinwords-content-packages-ui-'), 'Disposable profile required');
assert.ok(['import', 'activate', 'upgrade', 'isolate', 'missing'].includes(phase));
const bundledContentFile = path.join(root, 'content/content.db');
const phaseProfile = phase === 'missing' ? path.join(profile, 'missing-base') : profile;
fs.mkdirSync(phaseProfile, { recursive: true });
const contentFile = phase === 'missing' ? path.join(phaseProfile, 'content.db') : bundledContentFile;
const progressFile = path.join(phaseProfile, 'progress.db');
const contentDirectory = path.join(phaseProfile, 'content-packages'), readingDirectory = path.join(phaseProfile, 'reading-packages');
const stateFile = path.join(profile, 'content-audit-state.json');
const measurements = [], screenshots = [], cases = [], requests = [], errors = [], dialogCalls = [];
let win, context, nextFile, pageRun = 0;
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});

const json = value => JSON.stringify(value);
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evaluate = code => win.webContents.executeJavaScript(code, true);
const card = (id, status) => '[data-content-package=' + json(id) + ']' + (status ? '[data-content-status=' + json(status) + ']' : '');
const idle = '!document.querySelector(".cp-page").getAttribute("aria-busy").includes("true")';
async function waitFor(code) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    if (await evaluate(code)) return;
    await delay(75);
  }
  throw Error('Content package UI timeout: ' + code + '\n' + (await evaluate('document.body.innerText')).slice(0, 16000));
}
async function click(label) {
  const find = `Array.from(document.querySelectorAll('button,a')).find(el=>el.textContent.trim()===${json(label)}&&!el.disabled)`;
  await waitFor('!!(' + find + ')');
  await evaluate('(' + find + ').click()');
}
async function open(hash, ready) {
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { hash, query: { contentAuditRun: phase + '-' + (++pageRun) } });
  await waitFor(ready);
  await evaluate('document.fonts.ready');
  await delay(160);
}
async function management() {
  await open('/content', '!!document.querySelector(".cp-summary")&&!document.querySelector(".cp-library").textContent.includes("查看本机背包")');
}
async function capture(name, selector) {
  if (selector) await evaluate(`document.querySelector(${json(selector)})?.scrollIntoView({block:'start'})`);
  await delay(150);
  win.webContents.invalidate();
  await delay(120);
  const file = name + '.png';
  fs.writeFileSync(path.join(output, file), (await win.webContents.capturePage()).toPNG());
  screenshots.push(file);
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
  const overflow = [], lowContrast = [], contrasts = [];
  for (const element of document.querySelectorAll('body *')) {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (!rect.width || !rect.height || style.visibility !== 'visible' || style.display === 'none') continue;
    if (rect.left < -1 || rect.right > innerWidth + 1) overflow.push({ tag: element.tagName, class: element.className, left: rect.left, right: rect.right });
    const ownText = Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
    if (!/\p{L}|\p{N}/u.test(ownText) || element.matches(':disabled') || element.closest('select,[aria-hidden="true"]')) continue;
    const bg = background(element), fg = rgba(style.color);
    for (let parent = element; parent; parent = parent.parentElement) fg[3] *= Number(getComputedStyle(parent).opacity);
    const a = luminance(over(fg, bg)), b = luminance(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    contrasts.push(ratio);
    if (ratio < 4.5) lowContrast.push({ text: ownText.slice(0, 70), ratio });
  }
  const image = document.querySelector('img.rd-banner'), box = image?.getBoundingClientRect();
  return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight,
    bodyOverflow: getComputedStyle(document.body).overflowY, overflow, lowContrast, minContrast: Math.min(...contrasts),
    fontLoaded: document.fonts.check('500 20px "Noto Serif SC"', '提瓦特荧'),
    banner: image ? { width: image.naturalWidth, height: image.naturalHeight, ratio: box.width / box.height } : null };
}
async function inspect(name, banner = false) {
  await delay(450);
  const result = await evaluate('(' + measurePage.toString() + ')()');
  measurements.push({ name, ...result });
  assert.ok(result.scrollWidth <= result.clientWidth + 1, name + ': horizontal page overflow');
  assert.deepEqual(result.overflow, [], name + ': horizontal element overflow');
  assert.deepEqual(result.lowContrast, [], name + ': text contrast');
  assert.equal(result.fontLoaded, true, name + ': bundled Chinese font');
  assert.notEqual(result.bodyOverflow, 'hidden', name + ': vertical scrolling is available');
  if (banner) {
    assert.equal(result.banner?.width, 1600); assert.equal(result.banner.height, 400);
    assert.ok(Math.abs(result.banner.ratio - 4) < .025);
  }
}
async function reachable(selector) {
  const result = await evaluate(`(()=>{const el=document.querySelector(${json(selector)});if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight};})()`);
  assert.ok(result && result.top >= -1 && result.bottom <= result.height + 1, selector + ': reachable by scrolling');
}
async function preview(file, action) {
  nextFile = file;
  await click('导入内容包');
  await waitFor('!!document.querySelector(".cp-preview")&&' + idle);
  const text = await evaluate('document.querySelector(".cp-preview").innerText');
  assert.ok(text.includes({ install: '新增内容包', upgrade: '更新已有内容包', unchanged: '已安装相同版本，无需更新' }[action]), text);
  return text;
}
async function confirm(action = 'install') {
  await click(action === 'unchanged' ? '确认，无需更新' : action === 'upgrade' ? '确认更新' : '确认导入');
  await waitFor('!document.querySelector(".cp-preview")&&!!document.querySelector(".cp-feedback[role=status]")&&' + idle);
}
async function lists() { return evaluate('window.api.listContentPackages()'); }
function registry() { return fs.readFileSync(path.join(contentDirectory, 'registry.json'), 'utf8'); }
async function rejected(file, message) {
  const before = registry(), beforeList = await lists();
  const visibleBefore = await evaluate('Array.from(document.querySelectorAll(".cp-package-card")).map(el=>({id:el.dataset.contentPackage,status:el.dataset.contentStatus,text:el.innerText}))');
  nextFile = file; await click('导入内容包');
  await waitFor('!!document.querySelector(".cp-feedback[role=alert]")&&' + idle);
  const error = await evaluate('document.querySelector(".cp-feedback[role=alert]").innerText');
  assert.match(error, message);
  assert.equal(await evaluate('!!document.querySelector(".cp-preview")'), false);
  assert.equal(registry(), before, 'Rejected package cannot alter registry');
  assert.deepEqual(await lists(), beforeList, 'Rejected package cannot replace visible content');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".cp-package-card")).map(el=>({id:el.dataset.contentPackage,status:el.dataset.contentStatus,text:el.innerText}))'), visibleBefore,
    'Rejected file must retain the displayed package cards');
  return error;
}
async function authorPackage(format, filename, manifest, data) {
  const author = path.join(profile, 'author-' + filename);
  fs.mkdirSync(author, { recursive: true });
  fs.writeFileSync(path.join(author, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(author, 'data.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
  const target = path.join(profile, filename + (manifest.kind === 'words' ? '.gwwords' : '.gwcontent'));
  await format.packContentDirectory(author, target);
  return target;
}
async function generateState() {
  const format = context.load('content-package-format');
  const read = filename => JSON.parse(fs.readFileSync(path.join(root, 'content-library/examples', filename), 'utf8'));
  const words = { manifest: read('local-word-book/manifest.json'), data: read('local-word-book/data.json'), file: path.join(root, 'content-library/examples/local-word-book.gwwords') };
  const materials = { manifest: read('noelle-evening/manifest.json'), data: read('noelle-evening/data.json'), file: path.join(root, 'content-library/examples/noelle-evening.gwcontent') };
  const readingFile = path.join(root, 'reading-library/examples/shared-question.gwreading');
  for (const file of [words.file, materials.file, readingFile]) assert.ok(fs.existsSync(file), 'Example package missing: ' + file);
  const reading = context.load('reading-package-format').decodeReadingPackage(fs.readFileSync(readingFile)).data;
  const passage = reading.units.find(unit => unit.kind === 'passage');
  assert.ok(passage, 'Independent example reading');
  const files = {};
  files.conflict = await authorPackage(format, 'conflicting-version', { ...words.manifest, description: '同版本但内容不同的受控验收包。' }, words.data);
  files.incompatible = await authorPackage(format, 'incompatible', { ...words.manifest, id: 'ui.incompatible.words', minAppVersion: '999.0.0' }, words.data);
  files.dependency = await authorPackage(format, 'missing-dependency', { ...words.manifest, id: 'ui.missing-dependency.words', dependencies: [{ id: 'ui.required.content', minVersion: '1.0.0' }] }, words.data);
  files.validDependency = await authorPackage(format, 'valid-dependency', { ...words.manifest, id: 'ui.valid-dependent.words', dependencies: [{ id: materials.manifest.id, minVersion: '1.0.0' }] }, words.data);
  const unknown = structuredClone(words.data); unknown.books[0].lemmas = ['zzzxunknownword999'];
  files.unknown = await authorPackage(format, 'unknown-local-word', { ...words.manifest, id: 'ui.unknown-local.words' }, unknown);
  const upgradedData = structuredClone(words.data); upgradedData.books[0].lemmas = upgradedData.books[0].lemmas.slice(0, 2);
  upgradedData.books[0].name_zh += '（新版）';
  upgradedData.books[0].description = '新版从本机已有词库选择 pursuit 和 freedom；已有学习记录保留。';
  files.upgrade = await authorPackage(format, 'word-book-upgrade', { ...words.manifest, version: '1.1.0' }, upgradedData);
  files.changed = path.join(profile, 'changed-after-preview.gwwords'); fs.copyFileSync(words.file, files.changed);
  files.corrupt = path.join(profile, 'corrupt.gwcontent'); fs.writeFileSync(files.corrupt, 'not an offline content package', 'utf8');
  const state = { words, materials, files, upgradedData, reading: { id: reading.manifest.id, name: reading.manifest.name,
    unitId: passage.definition.id, questionCount: passage.definition.questions.length, file: readingFile }, originalContentSha256: sha(contentFile) };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}
async function importPhase(state) {
  const { words, materials, files, reading } = state;
  await management();
  const initial = await lists();
  assert.ok(!initial.some(item => item.id === words.manifest.id || item.id === materials.manifest.id));
  const legacyBase = initial.find(item => item.id === 'legacy-base-resources');
  assert.ok(legacyBase && legacyBase.kind === 'base' && legacyBase.status === 'active' && legacyBase.formatVersion === 0);
  const legacyText = await evaluate('document.querySelector(' + json(card(legacyBase.id)) + ').innerText');
  assert.ok(legacyText.includes('旧内置基础素材') && legacyText.includes('未登记') && legacyText.includes('旧布局尚无独立基础素材包版本'));
  assert.equal(/版本\s*0(?:\s|$)/u.test(legacyText), false, 'Legacy layout must not be presented as content version 0');
  assert.ok((await evaluate('document.querySelector(".cp-kinds").innerText')).includes('从本机已有词库选词'));
  await inspect('initial-management-1024x768'); await capture('01-management-1024x768');
  await reachable(card(legacyBase.id)); await inspect('legacy-base-card-1024x768');
  await capture('00-legacy-base-resources-1024x768', card(legacyBase.id));
  nextFile = null; await click('导入内容包');
  await waitFor('document.querySelector(".cp-feedback[role=status]")?.textContent.includes("取消选择")');
  const text = await preview(words.file, 'install');
  assert.ok(text.includes(words.manifest.name) && text.includes(words.manifest.author) && text.includes('1.0.0'));
  assert.ok(text.includes('1 本词书') && text.includes('3 个词'), 'Preview must state the actual word book counts');
  assert.ok(text.includes('需要重新打开应用') && text.includes('已有学习记录、收藏和奖励会保留'));
  assert.ok(!(await lists()).some(item => item.id === words.manifest.id), 'Preview cannot import');
  await inspect('word-preview-1024x768'); await capture('02-word-preview-1024x768', '.cp-preview');
  win.setContentSize(1024, 600); await reachable('.cp-preview .gw-actions button:last-child');
  await inspect('word-preview-actions-1024x600'); await capture('03-word-preview-actions-1024x600');
  await click('取消导入');
  assert.ok(!(await lists()).some(item => item.id === words.manifest.id));
  win.setContentSize(1024, 768);
  const materialText = await preview(materials.file, 'install');
  assert.ok(materialText.includes('1 篇资料') && materialText.includes('素材包'));
  await click('取消导入');
  assert.ok(!(await lists()).some(item => item.id === materials.manifest.id));
  cases.push({ name: 'dialog-cancel-and-full-metadata-preview-cancel-preserve-current-content', ok: true });

  await preview(words.file, 'install'); await confirm();
  await waitFor('!!document.querySelector(' + json(card(words.manifest.id, 'pending')) + ')');
  await preview(materials.file, 'install'); await confirm();
  await waitFor('!!document.querySelector(' + json(card(materials.manifest.id, 'pending')) + ')');
  assert.ok(!(await evaluate('window.api.listBooks()')).some(book => book.name_zh === words.data.books[0].name_zh));
  assert.ok(!(await evaluate('window.api.listChapters()')).some(chapter => chapter.title_en === materials.data.chapters[0].title_en));
  await inspect('pending-packages-1024x768'); await capture('04-pending-packages-1024x768', '.cp-library');
  await open('/', '!!document.querySelector("#book")');
  assert.equal(await evaluate('Array.from(document.querySelectorAll("#book option")).some(el=>el.textContent.includes(' + json(words.data.books[0].name_zh) + '))'), false);
  await inspect('pending-word-book-not-activated-on-home-1024x768');
  await management();
  const beforeDuplicate = registry();
  await preview(words.file, 'unchanged'); await confirm('unchanged');
  assert.equal(registry(), beforeDuplicate);
  assert.equal((await lists()).filter(item => item.id === words.manifest.id && item.status === 'pending').length, 1);
  await preview(materials.file, 'unchanged'); await confirm('unchanged');
  assert.equal(registry(), beforeDuplicate);
  const dependencyText = await preview(files.validDependency, 'install');
  assert.ok(dependencyText.includes('需要的内容') && dependencyText.includes(materials.manifest.name) && dependencyText.includes('待重启生效'));
  await click('取消导入'); assert.equal(registry(), beforeDuplicate);
  cases.push({ name: 'material-and-word-imports-remain-pending-and-repeat-import-is-idempotent', ok: true });

  const failures = [];
  failures.push({ kind: 'same-version-conflict', message: await rejected(files.conflict, /相同版本|同一包版本|同版本|内容不同|冲突/) });
  await inspect('same-version-conflict-1024x768'); await capture('05-same-version-conflict', '.cp-feedback');
  failures.push({ kind: 'incompatible-app-version', message: await rejected(files.incompatible, /版本.*不满足|不兼容|版本.*要求/) });
  await inspect('incompatible-version-1024x768'); await capture('06-incompatible-version', '.cp-feedback');
  failures.push({ kind: 'missing-dependency', message: await rejected(files.dependency, /依赖|ui.required.content/) });
  failures.push({ kind: 'unknown-local-word', message: await rejected(files.unknown, /词库|词条|zzzxunknownword999/) });
  failures.push({ kind: 'corrupt-file', message: await rejected(files.corrupt, /格式|文件|头部|标识|素材包/) });
  const beforeChanged = registry();
  await preview(files.changed, 'unchanged');
  fs.writeFileSync(files.changed, 'changed after validated preview', 'utf8');
  await click('确认，无需更新');
  await waitFor('!!document.querySelector(".cp-feedback[role=alert]")&&' + idle);
  assert.equal(registry(), beforeChanged); assert.equal(await evaluate('!!document.querySelector(".cp-preview")'), true);
  await click('取消导入');
  cases.push({ name: 'conflict-incompatibility-dependency-dictionary-corruption-and-file-change-keep-current-list', failures, ok: true });

  const readingText = await preview(reading.file, 'install');
  assert.ok(readingText.includes('阅读包') && readingText.includes('1 篇阅读') && readingText.includes(reading.questionCount + ' 道题'));
  assert.ok(readingText.includes('导入后即可') && !readingText.includes('需要重新打开应用'));
  await inspect('unified-reading-preview-1024x768'); await capture('07-unified-reading-preview', '.cp-preview');
  await confirm();
  assert.ok((await lists()).some(item => item.id === reading.id && item.status === 'active'));
  const units = await evaluate('window.api.listReadingUnits()'); assert.equal(units.length, 1); assert.equal(units[0].id, reading.unitId);
  await open('/reading?unitId=' + encodeURIComponent(reading.unitId), '!!document.querySelector("img.rd-banner")?.naturalWidth&&!!document.querySelector(".rd-question")');
  await inspect('unified-import-reading-immediate-1024x768', true); await capture('08-unified-import-reading-immediate', '#reading-passage');
  cases.push({ name: 'unified-reading-import-is-immediately-available-with-1600x400-banner', ok: true });
  await management(); win.setContentSize(1024, 600);
  await reachable('.cp-kinds article:last-child'); await inspect('management-bottom-1024x600'); await capture('09-management-bottom-1024x600');
  assert.ok(measurements.at(-1).scrollHeight > 600);
}
async function activatePhase(state) {
  const { words, materials, files, upgradedData } = state;
  await management();
  const current = await lists();
  assert.ok(current.some(item => item.id === words.manifest.id && item.status === 'active' && item.version === '1.0.0'));
  assert.ok(current.some(item => item.id === materials.manifest.id && item.status === 'active'));
  assert.ok(!current.some(item => item.status === 'pending'));
  await inspect('restarted-active-packages-1024x768'); await capture('10-restarted-active-packages', '.cp-library');
  await open('/', '!!document.querySelector("#book")&&Array.from(document.querySelectorAll("#book option")).some(el=>el.textContent.includes(' + json(words.data.books[0].name_zh) + '))');
  const id = words.manifest.id + ':' + words.data.books[0].id;
  const book = (await evaluate('window.api.listBooks()')).find(item => item.id === id);
  assert.equal(book.word_count, words.data.books[0].lemmas.length);
  await evaluate(`(()=>{const select=document.querySelector('#book');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${json(id)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor('window.api.getSetting("currentBook").then(value=>value===' + json(id) + ')');
  await inspect('imported-word-book-home-1024x768'); await capture('11-imported-word-book-home', '.gw-home-grid');
  win.setContentSize(1024, 600); await reachable('#study-size'); await inspect('imported-word-book-home-1024x600');
  await capture('12-imported-word-book-home-1024x600'); win.setContentSize(1024, 768);
  const chapter = (await evaluate('window.api.listChapters()')).find(item => item.title_en === materials.data.chapters[0].title_en);
  assert.ok(chapter, 'Imported custom chapter must appear in real chapter API');
  const quests = await evaluate('window.api.listQuests(' + chapter.id + ')'); assert.equal(quests.length, 1);
  await open('/browse?chapterId=' + chapter.id + '&questId=' + quests[0].id, 'document.querySelectorAll(".gw-line").length===1');
  const line = materials.data.chapters[0].quests[0].lines[0];
  assert.equal(await evaluate('document.querySelector(".gw-dialog-en").textContent'), line.text_en);
  assert.ok((await evaluate('document.querySelector(".gw-line").innerText')).includes(line.text_chs));
  await inspect('imported-material-dialogue-1024x768'); await capture('13-imported-material-dialogue', '.gw-line');
  cases.push({ name: 'actual-process-restart-activates-imported-word-book-and-bilingual-materials', bookId: id, wordCount: book.word_count, chapterId: chapter.id, ok: true });

  await management();
  const text = await preview(files.upgrade, 'upgrade');
  assert.ok(text.includes('本机当前版本：1.0.0') && text.includes('1.1.0') && text.includes('2 个词') && text.includes('已有学习记录会保留'));
  await inspect('word-book-upgrade-preview-1024x768'); await capture('14-word-book-upgrade-preview', '.cp-preview');
  await click('取消导入');
  assert.ok(!(await lists()).some(item => item.id === words.manifest.id && item.status === 'pending'));
  await preview(files.upgrade, 'upgrade'); await confirm('upgrade');
  assert.ok((await lists()).some(item => item.id === words.manifest.id && item.status === 'active' && item.version === '1.0.0'));
  assert.ok((await lists()).some(item => item.id === words.manifest.id && item.status === 'pending' && item.version === '1.1.0'));
  const old = (await evaluate('window.api.listBooks()')).find(item => item.id === id);
  assert.equal(old.word_count, words.data.books[0].lemmas.length); assert.notEqual(old.name_zh, upgradedData.books[0].name_zh);
  win.setContentSize(1024, 600); await reachable(card(words.manifest.id, 'pending') + ' .cp-facts');
  await inspect('active-and-pending-upgrade-1024x600'); await capture('15-active-and-pending-upgrade');
  cases.push({ name: 'upgrade-preview-cancel-and-confirm-keep-current-word-book-until-next-start', ok: true });
}
async function upgradePhase(state) {
  const { words, upgradedData } = state;
  await management();
  const entries = (await lists()).filter(item => item.id === words.manifest.id);
  assert.equal(entries.length, 1); assert.equal(entries[0].status, 'active'); assert.equal(entries[0].version, '1.1.0');
  assert.ok(!entries.some(item => item.status === 'pending'));
  await inspect('upgraded-word-book-active-1024x768'); await capture('16-upgraded-word-book-active', '.cp-library');
  await open('/', '!!document.querySelector("#book")&&document.querySelector("#book").selectedOptions[0].textContent.includes(' + json(upgradedData.books[0].name_zh) + ')');
  const book = (await evaluate('window.api.listBooks()')).find(item => item.id === words.manifest.id + ':' + words.data.books[0].id);
  assert.equal(book.word_count, upgradedData.books[0].lemmas.length);
  assert.equal(await evaluate('window.api.getSetting("currentBook")'), book.id, 'Current book setting survives upgrade');
  await inspect('upgraded-home-membership-1024x768'); await capture('17-upgraded-home-membership', '.gw-home-grid');
  cases.push({ name: 'second-process-restart-activates-updated-membership-and-preserves-current-book', wordCount: book.word_count, ok: true });
  // Damage only this fixture's imported reading revision, then start a fresh process.
  const registry = JSON.parse(fs.readFileSync(path.join(readingDirectory, 'registry.json'), 'utf8'));
  const entry = registry.active.find(item => item.id === state.reading.id);
  assert.match(entry.digest, /^[a-f0-9]{64}$/);
  const target = path.resolve(readingDirectory, 'revisions', entry.digest + '.gwreading');
  assert.equal(path.dirname(target), path.resolve(readingDirectory, 'revisions'));
  fs.writeFileSync(target, 'isolated imported reading damage', 'utf8');
}
async function isolatePhase(state) {
  await management();
  const all = await lists();
  assert.ok(all.some(item => item.id === state.reading.id && item.status === 'error'));
  assert.ok(all.some(item => item.id === state.words.manifest.id && item.status === 'active' && item.version === '1.1.0'));
  assert.ok(all.some(item => item.id === state.materials.manifest.id && item.status === 'active'));
  const text = await evaluate('document.querySelector(' + json(card(state.reading.id, 'error')) + ').innerText');
  assert.ok(text.includes('未能加载') && text.includes(state.reading.name));
  assert.ok(await evaluate('!!document.querySelector(' + json(card(state.reading.id, 'error') + ' [role=alert]') + ')'));
  await inspect('one-package-load-error-1024x768'); await capture('18-one-package-load-error', card(state.reading.id, 'error'));
  win.setContentSize(1024, 600); await reachable(card(state.reading.id, 'error') + ' [role=alert]');
  await inspect('one-package-load-error-1024x600'); await capture('19-one-package-load-error-1024x600');
  assert.equal(sha(contentFile), state.originalContentSha256, 'Bundled source database cannot be modified');
  cases.push({ name: 'single-package-load-error-keeps-other-package-types-and-bundled-source-unchanged', ok: true });
}
async function missingPhase(state) {
  await open('/', 'document.body.innerText.includes("本地内容包未找到")');
  assert.equal(await evaluate('window.api.contentAvailable()'), false);
  win.setContentSize(1024, 600); await reachable('a.gw-btn[href="#/content"]');
  await inspect('missing-base-home-1024x600'); await capture('20-missing-base-home-1024x600');
  await click('打开内容管理');
  await waitFor('!!document.querySelector(".cp-summary")&&!document.querySelector(".cp-library").textContent.includes("查看本机背包")');
  const missingList = await lists();
  assert.ok(missingList.some(item => item.kind === 'base' && item.status === 'error' && /基础/.test(item.name + item.message)), 'Missing base is explained in the package list');
  assert.ok(missingList.every(item => item.status === 'error'), 'No content may become active without a base');
  assert.ok(!missingList.some(item => item.id === 'legacy-base-resources'), 'Missing base cannot be labeled as a working legacy layout');
  nextFile = state.words.file; await click('导入内容包');
  await waitFor('!!document.querySelector(".cp-feedback[role=alert]")&&' + idle);
  const message = await evaluate('document.querySelector(".cp-feedback[role=alert]").innerText');
  assert.match(message, /基础素材包|基础内容/);
  assert.deepEqual(await lists(), missingList);
  await inspect('missing-base-import-guidance-1024x600'); await capture('21-missing-base-import-guidance', '.cp-feedback');
  cases.push({ name: 'missing-base-home-links-to-management-and-explains-word-book-dependency', ok: true });
}

(async () => {
  await app.whenReady();
  fs.mkdirSync(output, { recursive: true });
  assert.ok(fs.existsSync(path.join(root, 'out/renderer/index.html')), 'Build the renderer before this audit');
  context = loadMain(contentFile, progressFile, { contentPackagesDir: contentDirectory, readingPackagesDir: readingDirectory, bundledReadingPackagePath: null });
  await context.load('content-package-store').initializeContentPackages();
  const progress = context.load('progress-db'); progress.openProgressDb(); progress.setSetting('traveler', 'lumine');
  context.load('content-db').openContentDb();
  context.load('ipc').registerIpc();
  dialog.showOpenDialog = async (...args) => {
    const config = args.at(-1);
    assert.deepEqual(config.filters, [{ name: 'GenshinWords 内容包', extensions: ['gwcontent', 'gwwords', 'gwreading'] }]);
    assert.deepEqual(config.properties, ['openFile']);
    assert.notEqual(nextFile, undefined, 'Unexpected OS file dialog');
    const file = nextFile; nextFile = undefined;
    dialogCalls.push({ canceled: file === null, file: file ? path.basename(file) : null });
    return file === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [file] };
  };
  win = new BrowserWindow({ show: false, width: 1024, height: 768, useContentSize: true, webPreferences: {
    preload: path.join(root, 'out/preload/index.js'), sandbox: true, contextIsolation: true,
    spellcheck: false, offscreen: true, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  win.webContents.on('render-process-gone', (_event, details) => errors.push('Renderer gone: ' + details.reason));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    requests.push(details.url); callback({ cancel: true });
  });
  const state = phase === 'import' ? await generateState() : JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  await ({ import: importPhase, activate: activatePhase, upgrade: upgradePhase, isolate: isolatePhase, missing: missingPhase }[phase])(state);
  assert.deepEqual(errors, [], 'Renderer errors'); assert.deepEqual(requests, [], 'Offline UI attempted network requests');
  const report = { ok: true, phase, pid: process.pid, appVersion: app.getVersion(), packageVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    profileIsolation: true, bundledReadingDisabled: true, cases, dialogCalls, measurements, screenshots, errors, requests };
  fs.writeFileSync(path.join(output, 'phase-' + phase + '.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ ok: true, phase, cases: cases.length, measurements: measurements.length, screenshots: screenshots.length }));
})().then(() => finish(0), error => {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ ok: false, phase, error: error.stack, cases, measurements, dialogCalls, screenshots, errors, requests }, null, 2) + '\n', 'utf8');
  console.error(error); finish(1);
});
function finish(code) {
  win?.destroy();
  try { context?.close(); } catch (error) { console.error(error); code = 1; }
  app.exit(code);
}
