const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { setTimeout: delay } = require('node:timers/promises');
const { loadMain, root } = require('../helpers/load-main.cjs');

const profile = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
assert.ok(path.basename(profile).startsWith('genshinwords-reading-packages-ui-'), 'Use an isolated disposable profile');
const packageDirectory = path.join(profile, 'reading-packages');
const progressFile = path.join(profile, 'progress.db');
const options = { readingPackagesDir: packageDirectory, bundledReadingPackagePath: null };
const contentFile = path.join(root, 'content/content.db');
const measurements = [], requests = [], errors = [], cases = [], dialogCalls = [], pdfCalls = [];
const NEW_EXPLANATION = '【导入验收新版解析】';
let win, context, nextOpenFile, nextSaveFile, pageRun = 0;
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});

const evaluate = code => win.webContents.executeJavaScript(code, true);
async function waitFor(code) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (await evaluate(code)) return;
    await delay(60);
  }
  throw Error('Reading package UI timeout: ' + code + '\n' + (await evaluate('document.body.innerText')).slice(0, 14000));
}
async function click(label) {
  const text = JSON.stringify(label);
  await waitFor(`Array.from(document.querySelectorAll('button,a')).some(el=>el.textContent.trim()===${text}&&!el.disabled)`);
  await evaluate(`Array.from(document.querySelectorAll('button,a')).find(el=>el.textContent.trim()===${text}&&!el.disabled).click()`);
}
async function open(hash, ready) {
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { hash, query: { readingPackageAuditRun: String(++pageRun) } });
  await waitFor(ready);
  await evaluate('document.fonts.ready');
  await delay(150);
}
async function capture(name, selector) {
  if (selector) await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'start'})`);
  await delay(160);
  win.webContents.invalidate();
  await delay(100);
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
  const lowContrast = [], overflow = [], contrasts = [];
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
    if (ratio < 4.5) lowContrast.push({ text: ownText.slice(0, 70), ratio: Math.round(ratio * 100) / 100 });
  }
  const banner = document.querySelector('img.rd-banner'), box = banner?.getBoundingClientRect();
  return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight,
    bodyOverflow: getComputedStyle(document.body).overflowY, overflow, lowContrast,
    minContrast: Math.min(...contrasts), fontLoaded: document.fonts.check('500 20px "Noto Serif SC"', '提瓦特荧'),
    banner: banner ? { width: banner.naturalWidth, height: banner.naturalHeight, displayedRatio: box.width / box.height } : null };
}
async function inspect(name, hasBanner = false) {
  await delay(650);
  const measured = await evaluate('(' + measurePage.toString() + ')()');
  measurements.push({ name, ...measured });
  assert.ok(measured.scrollWidth <= measured.clientWidth + 1, name + ': page overflow');
  assert.deepEqual(measured.overflow, [], name + ': element overflow');
  assert.deepEqual(measured.lowContrast, [], name + ': low text contrast');
  assert.equal(measured.fontLoaded, true, name + ': local font missing');
  if (hasBanner) {
    assert.equal(measured.banner?.width, 1600, name + ': package banner missing');
    assert.equal(measured.banner.height, 400);
    assert.ok(Math.abs(measured.banner.displayedRatio - 4) < .025, name + ': banner must be 4:1');
  }
}
async function reachable(selector) {
  const target = JSON.stringify(selector);
  const measured = await evaluate(`(()=>{const el=document.querySelector(${target});if(!el)return null;el.scrollIntoView({block:'center'});const rect=el.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,height:innerHeight,body:getComputedStyle(document.body).overflowY};})()`);
  assert.ok(measured && measured.top >= -1 && measured.bottom <= measured.height + 1, selector + ': control must be reachable by scrolling');
  assert.notEqual(measured.body, 'hidden', selector + ': page scroll must remain available');
}
async function choose(question, answer) {
  const id = JSON.stringify('reading-q-' + question.id), value = JSON.stringify(answer);
  await evaluate(`(()=>{const form=document.getElementById(${id});const select=form.querySelector('select');if(select){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${value});select.dispatchEvent(new Event('change',{bubbles:true}));return;}const radio=Array.from(form.querySelectorAll('input[type=radio]')).find(el=>el.value===${value});if(radio){radio.click();return;}const input=form.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${value});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function fillPaper(unit) { for (const question of unit.questions) await choose(question, question.expected); }
async function submitPaper() {
  await click('交卷，看看答得怎么样');
  await waitFor('!!document.querySelector(".rd-paper-score")');
  if (await evaluate('!!document.querySelector(".rd-celebration")')) await click('收好啦！');
  await waitFor('!document.querySelector(".rd-celebration")&&!!document.querySelector(".rd-bilingual-paragraph")');
}
async function directory() {
  await click('← 返回故事目录');
  await waitFor('!!document.querySelector(".rd-packages")&&!document.querySelector(".rd-packages")?.getAttribute("aria-busy").includes("true")');
}
async function openUnit(id) {
  const selector = JSON.stringify('[data-reading-unit="' + id + '"] button');
  await waitFor(`!!document.querySelector(${selector})&&!document.querySelector(${selector}).disabled`);
  await evaluate(`document.querySelector(${selector}).click()`);
  await waitFor('!!document.querySelector("img.rd-banner")?.naturalWidth&&!!document.querySelector(".rd-question")');
}
async function previewFile(file, action) {
  nextOpenFile = file;
  await click('导入阅读包');
  await waitFor('!!document.querySelector(".rd-package-preview")&&!document.querySelector(".rd-packages").getAttribute("aria-busy").includes("true")');
  const text = await evaluate('document.querySelector(".rd-package-preview").innerText');
  assert.ok(text.includes(action), 'Preview action: ' + text);
}
async function confirmPackage(unchanged = false) {
  await click(unchanged ? '确认，无需更新' : '确认导入');
  await waitFor('!document.querySelector(".rd-package-preview")&&!document.querySelector(".rd-packages").getAttribute("aria-busy").includes("true")');
}
function assertPdf(file) {
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length > 2000, 'PDF must contain real reading content');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(bytes.toString('latin1'), /%%EOF\s*$/);
  // PDFKit emits ordinary image objects with direct byte lengths. Compare the
  // actual embedded banner streams, in addition to observing revision arguments.
  const source = bytes.toString('latin1'), images = [];
  const imageObject = /\d+\s+\d+\s+obj\s*<<(?:(?!endobj)[\s\S])*?\/Subtype\s*\/Image\b(?:(?!endobj)[\s\S])*?>>\s*stream\r?\n/g;
  let match;
  while ((match = imageObject.exec(source))) {
    const width = Number(/\/Width\s+(\d+)/.exec(match[0])?.[1]);
    const height = Number(/\/Height\s+(\d+)/.exec(match[0])?.[1]);
    const length = Number(/\/Length\s+(\d+)\b/.exec(match[0])?.[1]);
    assert.ok(length > 0, 'Expected a direct PDF image stream length');
    const start = imageObject.lastIndex;
    if (width === 1600 && height === 400)
      images.push({ width, height, sha256: createHash('sha256').update(bytes.subarray(start, start + length)).digest('hex') });
    imageObject.lastIndex = start + length;
  }
  assert.ok(images.length, 'Actual PDF must embed a 1600 × 400 reading banner');
  return images;
}
async function exportPdf(name, attemptId) {
  nextSaveFile = path.join(output, name + '.pdf');
  const before = pdfCalls.length;
  await click('保存题目与解析 PDF');
  await waitFor('document.querySelector("#reading-notice")?.textContent.includes("放进 PDF")');
  const images = assertPdf(nextSaveFile);
  const calls = pdfCalls.slice(before);
  assert.ok(calls.length >= 1, 'PDF must use the real artwork renderer');
  assert.ok(calls.every(args => args[2] === attemptId), 'Every PDF banner must use the exported attempt revision');
  cases.push({ name: 'pdf-' + name, attemptId, bytes: fs.statSync(nextSaveFile).size, bannerCalls: calls.length, images });
  nextSaveFile = undefined;
  return images;
}
function registerContext() {
  context = loadMain(contentFile, progressFile, options);
  const artwork = context.load('reading-artwork');
  const originalBanner = artwork.getReadingBannerBuffer;
  artwork.getReadingBannerBuffer = (...args) => { pdfCalls.push(args); return originalBanner(...args); };
  context.load('ipc').registerIpc();
}

(async () => {
  await app.whenReady();
  fs.mkdirSync(output, { recursive: true });
  assert.ok(fs.existsSync(path.join(root, 'out/renderer/index.html')), 'Build the renderer before running this audit');
  assert.ok(fs.existsSync(path.join(root, 'content/reading/base.gwreading')), 'Generate the bundled reading package first');
  registerContext();
  const format = context.load('reading-package-format');
  const base = format.decodeReadingPackage(fs.readFileSync(path.join(root, 'content/reading/base.gwreading'))).data;
  const selected = base.units.find(item => item.kind === 'passage' && item.composition !== 'split'
    && item.definition.type === 'reading' && item.definition.questions.length >= 2);
  assert.ok(selected, 'Need one independent reading from the bundled package');
  function packageData(id, unitId, name) {
    const definition = structuredClone(selected.definition);
    definition.id = unitId; definition.title = name; definition.level = 'sh_zhongkao';
    return { format: base.format, formatVersion: base.formatVersion,
      manifest: { id, name, version: '1.0.0', minAppVersion: '1.0.0', engineVersion: 1, createdAt: '2026-10-23T00:00:00.000Z' },
      units: [{ kind: 'passage', definition }], legacyGroups: [],
      sources: structuredClone(base.sources.filter(source => source.id === definition.materialId)),
      images: structuredClone(base.images.filter(image => image.path === definition.coverPath)) };
  }
  const primaryId = 'ui-reading-import-package', unitId = 'ui-reading-import-a';
  const sharedId = 'ui-reading-shared-package', sharedUnitId = 'ui-reading-import-shared';
  const primary = packageData(primaryId, unitId, '离线导入验收阅读包');
  const shared = packageData(sharedId, sharedUnitId, '共享题号验收阅读包');
  const upgraded = structuredClone(primary);
  upgraded.manifest.version = '1.1.0';
  upgraded.units[0].definition.title += '（新版）';
  upgraded.units[0].definition.questions[0].solution.explanation += '\n' + NEW_EXPLANATION;
  const replacementImage = base.images.find(image => image.sha256 !== primary.images[0].sha256);
  assert.ok(replacementImage, 'Need a second official image to prove attempt-specific banners');
  upgraded.units[0].definition.coverPath = replacementImage.path;
  upgraded.images = [structuredClone(replacementImage)];
  const primaryFile = path.join(profile, 'sample.gwreading'), sharedFile = path.join(profile, 'shared.gwreading');
  const upgradeFile = path.join(profile, 'upgrade.gwreading'), corruptFile = path.join(profile, 'corrupt.gwreading');
  const changedFile = path.join(profile, 'changed-after-preview.gwreading');
  const writePack = (file, data) => {
    const valid = format.validateReadingPackage(data, { appVersion: app.getVersion() });
    fs.writeFileSync(file, format.encodeReadingPackage(valid.data));
    return valid;
  };
  const primaryValidated = writePack(primaryFile, primary);
  writePack(sharedFile, shared); writePack(upgradeFile, upgraded); writePack(changedFile, primary);
  fs.writeFileSync(corruptFile, 'not a gzip reading package', 'utf8');
  assert.deepEqual(primary.units[0].definition.questions.map(question => question.id), shared.units[0].definition.questions.map(question => question.id));
  const bankUnit = primaryValidated.units[0];
  const packages = context.load('reading-package-store'), reading = context.load('reading');
  const rewards = context.load('rewards'), progress = context.load('progress-db'), content = context.load('content-db');
  const collections = context.load('collections'), wordTokens = context.load('../shared/text').wordTokens;
  progress.setSetting('traveler', 'lumine');
  const book = content.listBooks()[0];
  if (book) progress.setSetting('currentBook', book.id);
  assert.deepEqual(packages.listReadingPackages(), [], 'No bundled package may populate the clean fixture');
  assert.deepEqual(reading.listReadingUnits(), []);

  const originalOpenDialog = dialog.showOpenDialog, originalSaveDialog = dialog.showSaveDialog;
  dialog.showOpenDialog = async (...args) => {
    const config = args.at(-1);
    assert.deepEqual(config.filters, [{ name: 'GenshinWords 阅读包', extensions: ['gwreading'] }]);
    assert.deepEqual(config.properties, ['openFile']);
    assert.notEqual(nextOpenFile, undefined, 'Unexpected file dialog');
    const file = nextOpenFile; nextOpenFile = undefined;
    dialogCalls.push({ kind: 'open', canceled: file === null });
    return file === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [file] };
  };
  dialog.showSaveDialog = async (...args) => {
    assert.ok(nextSaveFile, 'Unexpected PDF dialog');
    assert.ok(args.at(-1).filters.some(filter => filter.extensions.includes('pdf')));
    dialogCalls.push({ kind: 'save', file: path.basename(nextSaveFile) });
    return { canceled: false, filePath: nextSaveFile };
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

  await open('/reading', '!!document.querySelector(".rd-packages")&&!document.querySelector(".rd-packages").textContent.includes("看看本机书架")');
  assert.equal(await evaluate('document.querySelectorAll(".rd-unit-card").length'), 0);
  await inspect('empty-catalog-1024x768'); await capture('01-empty-catalog-1024x768');
  nextOpenFile = null;
  await click('导入阅读包');
  await waitFor('document.querySelector(".rd-packages .rd-notice")?.textContent.includes("取消选择")');
  assert.deepEqual(packages.listReadingPackages(), []);
  await previewFile(primaryFile, '新增阅读包');
  const previewText = await evaluate('document.querySelector(".rd-package-preview").innerText');
  assert.ok(previewText.includes(primary.manifest.name) && previewText.includes('1.0.0'));
  assert.ok(previewText.includes('1 篇阅读') && previewText.includes(bankUnit.questions.length + ' 题'));
  assert.deepEqual(packages.listReadingPackages(), [], 'Preview must not activate content');
  await inspect('preview-install-1024x768'); await capture('02-preview-install-1024x768', '.rd-package-preview');
  win.setContentSize(1024, 600);
  await reachable('.rd-package-preview .gw-actions button:last-child');
  await inspect('preview-install-1024x600'); await capture('03-preview-actions-1024x600');
  win.setContentSize(1024, 768);
  await click('取消导入');
  assert.deepEqual(packages.listReadingPackages(), []);
  cases.push({ name: 'clean-profile-preview-cancel', ok: true });

  await previewFile(primaryFile, '新增阅读包'); await confirmPackage();
  await waitFor('document.querySelectorAll(".rd-unit-card").length===1');
  assert.equal(packages.listReadingPackages()[0].builtIn, false);
  assert.equal(reading.listReadingUnits().length, 1);
  await inspect('installed-catalog-1024x768'); await capture('04-installed-catalog-1024x768');
  const registryBeforeDuplicate = fs.readFileSync(path.join(packageDirectory, 'registry.json'), 'utf8');
  await previewFile(primaryFile, '已安装相同版本，无需更新'); await confirmPackage(true);
  assert.equal(fs.readFileSync(path.join(packageDirectory, 'registry.json'), 'utf8'), registryBeforeDuplicate);
  assert.equal(await evaluate('document.querySelectorAll(".rd-unit-card").length'), 1);
  nextOpenFile = corruptFile; await click('导入阅读包');
  await waitFor('!!document.querySelector(".rd-package-operation-error")');
  assert.equal(await evaluate('document.querySelectorAll(".rd-unit-card").length'), 1);
  assert.equal(reading.listReadingUnits().length, 1);
  await inspect('corrupt-file-keeps-catalog-1024x768'); await capture('05-corrupt-file-keeps-catalog-1024x768', '.rd-packages');
  await previewFile(changedFile, '已安装相同版本，无需更新');
  fs.writeFileSync(changedFile, 'changed after complete preview', 'utf8');
  await click('确认，无需更新');
  await waitFor('!!document.querySelector(".rd-package-operation-error")&&!document.querySelector(".rd-packages").getAttribute("aria-busy").includes("true")');
  assert.equal(reading.listReadingUnits().length, 1);
  assert.equal(fs.readFileSync(path.join(packageDirectory, 'registry.json'), 'utf8'), registryBeforeDuplicate);
  await click('取消导入');
  cases.push({ name: 'duplicate-corrupt-and-changed-file-preserve-catalog', ok: true });

  await openUnit(unitId);
  assert.equal(await evaluate('!!document.querySelector(".rd-packages")'), false, 'Import belongs in the directory');
  const originalBanner = await evaluate('document.querySelector("img.rd-banner").src');
  await inspect('imported-reading-banner-1024x768', true); await capture('06-imported-reading-banner-1024x768', '#reading-passage');
  const paragraphs = reading.getReadingUnit(unitId).paragraphs;
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".rd-paragraph p")).map(el=>{const copy=el.cloneNode(true);copy.querySelectorAll(".rd-inline-note").forEach(note=>note.remove());return copy.textContent;})'), paragraphs);
  await fillPaper(bankUnit); await submitPaper();
  const firstRound = reading.getReadingUnit(unitId);
  assert.equal(firstRound.paperResult.score, bankUnit.questions.length);
  assert.equal(rewards.getRewards().readingTotal, bankUnit.questions.length);
  assert.equal(await evaluate('document.querySelectorAll(".rd-bilingual-paragraph").length'), paragraphs.length);
  await inspect('imported-reading-analysis-1024x768', true); await capture('07-imported-reading-analysis-1024x768', '#reading-analysis');
  const bilingual = reading.getReadingAnalysis(firstRound.attemptId).bilingualParagraphs;
  let collected;
  for (const paragraph of bilingual) {
    const tokens = wordTokens(paragraph.textEn);
    const tokenIndex = tokens.findIndex(token => content.lookupWordByLemma(token.text));
    if (tokenIndex >= 0) { collected = { paragraph: paragraph.paragraph, tokenIndex, word: content.lookupWordByLemma(tokens[tokenIndex].text), surface: tokens[tokenIndex].text }; break; }
  }
  assert.ok(collected, 'An imported official source must contain a real dictionary word');
  await evaluate(`(()=>{const token=document.getElementById(${JSON.stringify('reading-bilingual-' + unitId + '-' + collected.paragraph)}).querySelectorAll('.gw-token')[${collected.tokenIndex}];token.scrollIntoView({block:'center'});token.click();})()`);
  await waitFor('!!document.querySelector(".rd-word-popup")&&!document.querySelector(".rd-word-popup").textContent.includes("派蒙翻翻词典")');
  await click('加入收藏词表');
  await waitFor('document.querySelector(".rd-word-popup")?.textContent.includes("一起放进收藏词表")');
  const collection = collections.listCollection().find(item => item.word.id === collected.word.id);
  assert.equal(collection.source.origin, 'reading');
  assert.equal(collection.source.text.slice(collection.source.start, collection.source.end), collected.surface);
  const collectionSnapshot = JSON.stringify(collection.source);
  await inspect('imported-reading-collection-1024x768', true); await capture('08-imported-reading-collection-1024x768');
  await click('×');
  const originalPdfImages = await exportPdf('imported-reading-v1', firstRound.attemptId);
  cases.push({ name: 'actual-imported-answer-analysis-collection-and-pdf', questions: bankUnit.questions.length, ok: true });

  await directory(); await previewFile(sharedFile, '新增阅读包'); await confirmPackage();
  await waitFor('document.querySelectorAll(".rd-unit-card").length===2');
  await openUnit(sharedUnitId); await fillPaper(bankUnit); await submitPaper();
  assert.equal(reading.getReadingUnit(sharedUnitId).paperResult.earnedCount, 0, 'Shared logical qIDs must not award twice across packages');
  assert.equal(rewards.getRewards().readingTotal, bankUnit.questions.length);
  cases.push({ name: 'shared-question-ids-preserve-global-reward-dedupe', ok: true });

  await directory(); await openUnit(unitId); await click('再读再答一次');
  await waitFor('!!document.querySelector("#reading-questions button[type=submit]")');
  await choose(bankUnit.questions[0], bankUnit.questions[0].expected);
  await directory();
  const draft = reading.getReadingUnit(unitId);
  assert.equal(draft.answers[bankUnit.questions[0].id], bankUnit.questions[0].expected);
  assert.equal(draft.paperResult, null);
  await previewFile(upgradeFile, '更新已有阅读包');
  assert.ok((await evaluate('document.querySelector(".rd-package-preview").innerText')).includes('当前版本 1.0.0'));
  await inspect('upgrade-preview-1024x768'); await capture('09-upgrade-preview-1024x768', '.rd-package-preview');
  await confirmPackage(); await waitFor('document.querySelector(".rd-unit-card")?.textContent.includes("新版")');
  await openUnit(unitId);
  await waitFor('!!document.querySelector(".rd-version-notice")');
  assert.equal(reading.getReadingUnit(unitId).attemptId, draft.attemptId);
  assert.equal(reading.getReadingUnit(unitId).contentVersion, '1.0.0');
  assert.equal(reading.getReadingUnit(unitId).answers[bankUnit.questions[0].id], bankUnit.questions[0].expected);
  assert.equal(await evaluate('document.querySelector("img.rd-banner").src'), originalBanner, 'Old draft banner must remain pinned');
  assert.ok(!(await evaluate('document.querySelector("#reading-unit-title").textContent')).includes('新版'));
  await inspect('old-draft-version-notice-1024x768', true); await capture('10-old-draft-version-notice-1024x768', '.rd-version-notice');
  win.setContentSize(1024, 600);
  await reachable('.rd-version-notice .gw-actions button:last-child');
  await inspect('old-draft-version-notice-1024x600', true); await capture('11-old-draft-version-notice-1024x600');
  win.setContentSize(1024, 768);
  await click('继续本轮'); await fillPaper(bankUnit); await submitPaper();
  assert.ok(!reading.getReadingAnalysis(draft.attemptId).questions[0].explanation.includes(NEW_EXPLANATION));
  assert.equal(await evaluate('document.querySelector("img.rd-banner").src'), originalBanner);
  const oldPdfImages = await exportPdf('old-draft-after-upgrade-v1', draft.attemptId);
  assert.deepEqual(oldPdfImages, originalPdfImages, 'Exported old round must embed the exact original banner after upgrade');
  await click('从新版开始新一轮');
  await waitFor('document.querySelector("#reading-unit-title")?.textContent.includes("新版")&&!!document.querySelector("#reading-questions button[type=submit]")');
  let current = reading.getReadingUnit(unitId);
  assert.notEqual(current.attemptId, draft.attemptId);
  assert.equal(current.contentVersion, '1.1.0');
  assert.deepEqual(current.answers, {});
  assert.equal(await evaluate('!!document.querySelector(".rd-version-notice")'), false);
  assert.notEqual(await evaluate('document.querySelector("img.rd-banner").src'), originalBanner, 'A new round must use the new image');
  await inspect('new-round-upgraded-banner-1024x768', true); await capture('12-new-round-upgraded-banner-1024x768', '#reading-passage');
  await fillPaper(bankUnit); await submitPaper();
  assert.ok((await evaluate('document.querySelector(".rd-analysis").textContent')).includes(NEW_EXPLANATION));
  assert.equal(reading.getReadingUnit(unitId).paperResult.earnedCount, 0);
  assert.equal(rewards.getRewards().readingTotal, bankUnit.questions.length);
  const newPdfImages = await exportPdf('new-round-upgraded-v1.1', current.attemptId);
  assert.notDeepEqual(newPdfImages, originalPdfImages, 'Exported new round must embed the updated banner');
  assert.equal(JSON.stringify(collections.listCollection().find(item => item.word.id === collected.word.id).source), collectionSnapshot);
  assert.ok(!reading.getReadingDocument(unitId, draft.attemptId).analysis.questions[0].explanation.includes(NEW_EXPLANATION));
  cases.push({ name: 'unfinished-draft-pins-old-content-new-round-uses-upgrade', oldAttempt: draft.attemptId, newAttempt: current.attemptId, ok: true });

  // Collection and reward records must reopen the round that actually created
  // the source, even when a newer round now exists for the same unit ID.
  await open('/collection', '!!document.querySelector(".gw-collection-entry")');
  const collectionHref = await evaluate('Array.from(document.querySelectorAll(".gw-collection-entry a")).find(el=>el.textContent.trim()==="回到故事原文").getAttribute("href")');
  assert.ok(collectionHref.includes('attemptId=' + firstRound.attemptId), 'Collection source link must identify its original round');
  await click('回到故事原文');
  await waitFor('!!document.querySelector(".rd-analysis")&&!!document.querySelector("img.rd-banner")?.naturalWidth');
  assert.ok((await evaluate('location.hash')).includes('attemptId=' + firstRound.attemptId));
  assert.ok(!(await evaluate('document.querySelector(".rd-analysis").textContent')).includes(NEW_EXPLANATION));
  assert.equal(await evaluate('document.querySelector("img.rd-banner").src'), originalBanner);
  assert.equal(reading.getReadingUnit(unitId).attemptId, current.attemptId, 'Opening history must not replace the default current round');
  await inspect('historical-collection-source-1024x768', true); await capture('14-historical-collection-source-1024x768', '#reading-analysis');
  await directory(); await openUnit(unitId);
  await waitFor('document.querySelector(".rd-analysis")?.textContent.includes(' + JSON.stringify(NEW_EXPLANATION) + ')');
  assert.ok(!(await evaluate('location.hash')).includes('attemptId='), 'Directory reads the current round without a historical pin');

  await open('/rewards', '!!document.querySelector(".gw-reward-entry")');
  const rewardHref = await evaluate('Array.from(document.querySelectorAll(".gw-reward-entry a")).find(el=>el.getAttribute("href").includes(' + JSON.stringify('questionId=' + encodeURIComponent(bankUnit.questions[0].id)) + ')).getAttribute("href")');
  assert.ok(rewardHref.includes('attemptId=' + firstRound.attemptId), 'Reading reward link must identify the round that earned it');
  await evaluate('Array.from(document.querySelectorAll(".gw-reward-entry a")).find(el=>el.getAttribute("href")===' + JSON.stringify(rewardHref) + ').click()');
  await waitFor('!!document.getElementById(' + JSON.stringify('reading-analysis-q-' + bankUnit.questions[0].id) + ')&&!!document.querySelector("img.rd-banner")?.naturalWidth');
  assert.ok((await evaluate('location.hash')).includes('attemptId=' + firstRound.attemptId));
  assert.equal(await evaluate('document.querySelector("img.rd-banner").src'), originalBanner);
  assert.ok(!(await evaluate('document.querySelector(".rd-analysis").textContent')).includes(NEW_EXPLANATION));
  assert.equal(rewards.getRewards().readingTotal, bankUnit.questions.length);
  await inspect('historical-reward-source-1024x768', true); await capture('15-historical-reward-source-1024x768', '#reading-analysis');
  const priorCurrentAttempt = current.attemptId;
  await click('从新版开始新一轮');
  await waitFor('!location.hash.includes("attemptId=")&&document.querySelector("#reading-unit-title")?.textContent.includes("新版")&&!!document.querySelector("#reading-questions button[type=submit]")');
  current = reading.getReadingUnit(unitId);
  assert.notEqual(current.attemptId, priorCurrentAttempt);
  assert.equal(current.contentVersion, '1.1.0');
  assert.deepEqual(current.answers, {});
  await fillPaper(bankUnit); await submitPaper();
  assert.equal(rewards.getRewards().readingTotal, bankUnit.questions.length);
  cases.push({ name: 'collection-and-reward-links-pin-the-original-round-new-round-clears-pin', sourceAttempt: firstRound.attemptId,
    latestAttempt: current.attemptId, collectionHref, rewardHref, ok: true });

  // Simulate a restart with only the secondary package damaged on disk.
  const registry = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'registry.json'), 'utf8'));
  const secondary = registry.active.find(item => item.id === sharedId);
  assert.match(secondary.digest, /^[a-f0-9]{64}$/);
  const damagedRevision = path.join(packageDirectory, 'revisions', secondary.digest + '.gwreading');
  assert.ok(path.resolve(damagedRevision).startsWith(path.resolve(packageDirectory) + path.sep));
  fs.writeFileSync(damagedRevision, 'isolated secondary package corruption', 'utf8');
  for (const channel of Object.keys(context.load('ipc').handlers)) ipcMain.removeHandler(channel);
  context.close(); context = undefined; registerContext();
  await open('/reading', '!!document.querySelector(".rd-package-load-error")&&document.querySelectorAll(".rd-unit-card").length===1');
  assert.ok((await evaluate('document.querySelector(".rd-package-load-error").textContent')).includes(shared.manifest.name));
  assert.equal(context.load('reading').listReadingUnits().length, 1);
  assert.equal(context.load('rewards').getRewards().readingTotal, bankUnit.questions.length);
  await inspect('single-package-error-isolated-1024x768'); await capture('13-single-package-error-isolated-1024x768', '.rd-packages');
  await openUnit(unitId);
  await waitFor('document.querySelector(".rd-analysis")?.textContent.includes(' + JSON.stringify(NEW_EXPLANATION) + ')');
  assert.equal(context.load('reading').getReadingUnit(unitId).attemptId, current.attemptId);
  cases.push({ name: 'one-package-load-failure-keeps-healthy-package-history-and-rewards', ok: true });

  dialog.showOpenDialog = originalOpenDialog; dialog.showSaveDialog = originalSaveDialog;
  assert.deepEqual(errors, [], 'Renderer errors');
  assert.deepEqual(requests, [], 'Offline import/reading/PDF attempted network requests');
  const report = { ok: true, profileIsolation: true, bundledPackageDisabled: true,
    importedQuestions: bankUnit.questions.length, screenshots: fs.readdirSync(output).filter(file => file.endsWith('.png')).length,
    cases, dialogCalls, measurements, minContrast: Math.min(...measurements.map(item => item.minContrast)), errors, requests };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  if (fs.existsSync(path.join(output, 'failure.json'))) fs.unlinkSync(path.join(output, 'failure.json'));
  console.log(JSON.stringify({ ok: true, cases: cases.length, measurements: measurements.length, screenshots: report.screenshots, output }));
})().then(() => finish(0), error => {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, cases, measurements, dialogCalls, errors, requests }, null, 2) + '\n', 'utf8');
  console.error(error); finish(1);
});
function finish(code) { win?.destroy(); context?.close(); app.exit(code); }
