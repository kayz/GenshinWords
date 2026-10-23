const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, dialog } = require('electron');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { loadMain, root } = require('../helpers/load-main.cjs');
const profile = path.resolve(process.argv[2]), output = path.resolve(process.argv[3]), phase = process.argv[4];
assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
assert.ok(path.basename(profile).startsWith('genshinwords-resource-directories-ui-'));
assert.ok(['selection', 'restart', 'disconnected', 'restored'].includes(phase));
const contentPackages = path.join(profile, 'content-packages'), readingPackages = path.join(profile, 'reading-packages');
const stateFile = path.join(profile, 'resource-audit-state.json');
const cases = [], measurements = [], screenshots = [], requests = [], errors = [], dialogs = [];
let win, context, nextDirectory, pageRun = 0;
app.setPath('userData', profile); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking'); app.commandLine.appendSwitch('disable-component-update');
app.on('window-all-closed', () => {});
const json = value => JSON.stringify(value);
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evaluate = code => win.webContents.executeJavaScript(code, true);
const idle = '!document.querySelector(".cp-page").getAttribute("aria-busy").includes("true")';
async function waitFor(code) {
  const end = Date.now() + 120000;
  while (Date.now() < end) { if (await evaluate(code)) return; await delay(70); }
  throw Error('Resource directory UI timeout: ' + code + '\n' + (await evaluate('document.body.innerText')).slice(0, 16000));
}
async function click(label) {
  const find = `Array.from(document.querySelectorAll('button,a')).find(el=>el.textContent.trim()===${json(label)}&&!el.disabled)`;
  await waitFor('!!(' + find + ')'); await evaluate('(' + find + ').click()');
}
async function open(hash, ready) {
  await win.loadFile(path.join(root, 'out/renderer/index.html'), { hash, query: { resourceAudit: phase + '-' + (++pageRun) } });
  await waitFor(ready); await evaluate('document.fonts.ready'); await delay(150);
}
async function management() { await open('/content', '!!document.querySelector(".cp-summary")&&!document.querySelector(".cp-directories").textContent.includes("查看已选的资源目录")'); }
async function capture(name, selector) {
  if (selector) await evaluate('document.querySelector(' + json(selector) + ')?.scrollIntoView({block:"start"})');
  await delay(160); win.webContents.invalidate(); await delay(100);
  const file = name + '.png'; fs.writeFileSync(path.join(output, file), (await win.webContents.capturePage()).toPNG()); screenshots.push(file);
}
function measurePage() {
  function rgba(text) { const n = text.match(/[\d.]+/g)?.map(Number); return n ? [n[0], n[1], n[2], n.length > 3 ? n[3] : 1] : [0, 0, 0, 0]; }
  function over(a, b) { return a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3])).concat(1); }
  function background(el) { const c = rgba(getComputedStyle(el).backgroundColor); return c[3] === 1 ? c : over(c, el.parentElement ? background(el.parentElement) : [255, 255, 255, 1]); }
  function luminance(c) { return c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0); }
  const overflow = [], lowContrast = [], ratios = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (!r.width || !r.height || s.display === 'none' || s.visibility !== 'visible') continue;
    if (r.left < -1 || r.right > innerWidth + 1) overflow.push({ tag: el.tagName, class: el.className, left: r.left, right: r.right });
    const text = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
    if (!/\p{L}|\p{N}/u.test(text) || el.matches(':disabled') || el.closest('select,[aria-hidden="true"]')) continue;
    const bg = background(el), fg = rgba(s.color);
    for (let parent = el; parent; parent = parent.parentElement) fg[3] *= Number(getComputedStyle(parent).opacity);
    const a = luminance(over(fg, bg)), b = luminance(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    ratios.push(ratio); if (ratio < 4.5) lowContrast.push({ text: text.slice(0, 60), ratio });
  }
  return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight, bodyOverflow: getComputedStyle(document.body).overflowY, overflow, lowContrast,
    minContrast: Math.min(...ratios), fontLoaded: document.fonts.check('500 20px "Noto Serif SC"', '提瓦特荧') };
}
async function inspect(name) {
  await delay(300); const m = await evaluate('(' + measurePage.toString() + ')()'); measurements.push({ name, ...m });
  assert.equal(m.width, 1024); assert.ok(m.scrollWidth <= m.clientWidth + 1, name + ': horizontal overflow');
  assert.deepEqual(m.overflow, []); assert.deepEqual(m.lowContrast, []); assert.equal(m.fontLoaded, true); assert.notEqual(m.bodyOverflow, 'hidden');
}
async function reachable(selector) {
  const result = await evaluate(`(()=>{const el=document.querySelector(${json(selector)});if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight};})()`);
  assert.ok(result && result.top >= -1 && result.bottom <= result.height + 1, selector + ': scroll reachable');
}
async function preview(directory, kind) {
  nextDirectory = directory; await click('选择资源目录'); await waitFor('!!document.querySelector(".cp-directory-preview")&&' + idle);
  if (kind) assert.ok((await evaluate('document.querySelector(".cp-directory-preview").innerText')).includes(kind));
}
async function confirm() {
  await click('确认载入'); await waitFor('!!document.querySelector(".cp-directory-result")&&!document.querySelector(".cp-directory-preview")&&' + idle);
}
async function status() { return evaluate('window.api.getResourceDirectories()'); }
async function packages() { return evaluate('window.api.listContentPackages()'); }
function contained(file) { const rel = path.relative(profile, path.resolve(file)); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), 'Only disposable profile sources can be changed'); }
function move(from, to) { contained(from); contained(to); assert.equal(fs.lstatSync(from).isSymbolicLink(), false); fs.renameSync(from, to); }
async function rawFixture(directory, name, color) {
  fs.mkdirSync(path.join(directory, 'images'), { recursive: true }); fs.mkdirSync(path.join(directory, 'audio'), { recursive: true });
  const db = new Database(path.join(directory, 'content.db'));
  db.exec(`CREATE TABLE words(id INTEGER PRIMARY KEY,lemma TEXT NOT NULL,phonetic TEXT NOT NULL DEFAULT '',translation TEXT NOT NULL,pos TEXT NOT NULL DEFAULT 'n.',phonetic_uk TEXT DEFAULT '',phonetic_us TEXT DEFAULT '',audio_uk TEXT,audio_us TEXT);
    CREATE TABLE books(id TEXT PRIMARY KEY,name TEXT,name_zh TEXT,description TEXT,sort_order INTEGER);
    CREATE TABLE book_words(book_id TEXT,word_id INTEGER,rank INTEGER,PRIMARY KEY(book_id,word_id));
    CREATE TABLE chapters(id INTEGER PRIMARY KEY,type TEXT,version TEXT,title_en TEXT,title_chs TEXT,cover_path TEXT,sort_order INTEGER);
    CREATE TABLE quests(id INTEGER PRIMARY KEY,chapter_id INTEGER,title_en TEXT,title_chs TEXT,sort_order INTEGER,cover_path TEXT);
    CREATE TABLE dialog_lines(id INTEGER PRIMARY KEY,quest_id INTEGER,speaker TEXT,text_en TEXT,text_chs TEXT,sort_order INTEGER);
    INSERT INTO words(id,lemma,translation,audio_us) VALUES(1,'journey','旅行','audio/ui.wav'),(2,'freedom','自由',NULL),(3,'pursuit','追寻',NULL);
    INSERT INTO books VALUES('raw-ui-book','RAW Reading Words','原始目录小词书','由所选原始资源目录直接提供。',1);
    INSERT INTO book_words VALUES('raw-ui-book',1,1),('raw-ui-book',2,2),('raw-ui-book',3,3);
    INSERT INTO chapters VALUES(101,'book','1.0','Raw Resource Story','原始资源故事','ui.png',1);
    INSERT INTO quests VALUES(1001,101,'A Journey','一场旅行',1,'ui.png');
    INSERT INTO dialog_lines VALUES(10001,1001,'Paimon','Freedom begins with a journey.','自由从一场旅行开始。',1);`); db.close();
  const materials = new Database(path.join(directory, 'materials.db'));
  materials.exec("CREATE TABLE materials(id TEXT PRIMARY KEY);CREATE TABLE texts(material_id TEXT,locale TEXT,text TEXT,paragraphs_json TEXT);INSERT INTO materials VALUES('raw-one');INSERT INTO texts VALUES('raw-one','en','Freedom begins with a journey.','[\"Freedom begins with a journey.\"]');"); materials.close();
  await sharp({ create: { width: 1600, height: 400, channels: 3, background: color } }).png().toFile(path.join(directory, 'images/ui.png'));
  const audio = Buffer.alloc(44 + 1600); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(1600, 40);
  fs.writeFileSync(path.join(directory, 'audio/ui.wav'), audio);
  fs.writeFileSync(path.join(directory, 'resource-manifest.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8');
}
async function generateState() {
  const directories = { raw: path.join(profile, 'raw-resource-directory'), mixed: path.join(profile, 'mixed-resource-directory'), changed: path.join(profile, 'changed-resource-directory'), packages: path.join(profile, 'source-packages'), empty: path.join(profile, 'empty-source'), detached: path.join(profile, 'mixed-source-detached') };
  await rawFixture(directories.raw, '原始资料 · 离线目录', '#537860'); await rawFixture(directories.mixed, '混合资料 · 离线目录', '#486b91'); await rawFixture(directories.changed, '预览后变化的目录', '#735d89');
  fs.mkdirSync(directories.packages); fs.mkdirSync(directories.empty);
  const format = context.load('content-package-format');
  async function wordPack(label, id, lemmas, bookName, minAppVersion = '1.1.0') {
    const author = path.join(profile, 'author-' + label); fs.mkdirSync(author);
    fs.writeFileSync(path.join(author, 'manifest.json'), JSON.stringify({ id, name: bookName, kind: 'words', version: '1.0.0', minAppVersion, author: 'UI audit', createdAt: '2026-10-23' }), 'utf8');
    fs.writeFileSync(path.join(author, 'data.json'), JSON.stringify({ books: [{ id: 'small', name: label, name_zh: bookName, description: '从本机已有词库选词。', lemmas }] }), 'utf8');
    const file = path.join(profile, label + '.gwwords'); await format.packContentDirectory(author, file); return file;
  }
  const wordFile = await wordPack('directory-words', 'ui.directory.words', ['journey', 'freedom'], '目录载入小词书');
  const extraFile = await wordPack('rescan-words', 'ui.rescan.words', ['pursuit'], '重新扫描小词书');
  const incompatible = await wordPack('incompatible', 'ui.incompatible.words', ['journey'], '版本不兼容词书', '999.0.0');
  const material = path.join(root, 'content-library/examples/noelle-evening.gwcontent');
  const reading = path.join(root, 'reading-library/examples/shared-question.gwreading');
  for (const directory of [directories.packages, directories.mixed]) {
    fs.copyFileSync(wordFile, path.join(directory, 'words.gwwords')); fs.copyFileSync(material, path.join(directory, 'material.gwcontent')); fs.copyFileSync(reading, path.join(directory, 'reading.gwreading'));
    fs.writeFileSync(path.join(directory, 'broken.gwwords'), 'controlled invalid package', 'utf8');
  }
  fs.copyFileSync(incompatible, path.join(directories.packages, 'incompatible.gwwords'));
  const baseAuthor = path.join(profile, 'author-compact-base'); fs.mkdirSync(baseAuthor);
  fs.copyFileSync(path.join(directories.raw, 'content.db'), path.join(baseAuthor, 'content.db')); fs.copyFileSync(path.join(directories.raw, 'materials.db'), path.join(baseAuthor, 'materials.db'));
  fs.mkdirSync(path.join(baseAuthor, 'images')); fs.mkdirSync(path.join(baseAuthor, 'audio'));
  fs.copyFileSync(path.join(directories.raw, 'images/ui.png'), path.join(baseAuthor, 'images/ui.png')); fs.copyFileSync(path.join(directories.raw, 'audio/ui.wav'), path.join(baseAuthor, 'audio/ui.wav'));
  fs.writeFileSync(path.join(baseAuthor, 'manifest.json'), JSON.stringify({ id: 'ui.directory.base', name: '混合目录中的基础包', kind: 'base', version: '1.0.0', minAppVersion: '1.1.0', author: 'UI audit', createdAt: '2026-10-23' }), 'utf8');
  await format.packContentDirectory(baseAuthor, path.join(directories.mixed, 'base.gwcontent'));
  const data = context.load('reading-package-format').decodeReadingPackage(fs.readFileSync(reading)).data;
  const state = { directories, extraFile, reading: { id: data.manifest.id, unitId: data.units.find(unit => unit.kind === 'passage').definition.id }, rawSourceSha: hash(path.join(directories.raw, 'content.db')), mixedSourceSha: hash(path.join(directories.mixed, 'content.db')) };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8'); return state;
}
async function mediaCheck(directory) {
  const chapter = await evaluate('window.api.getChapter(101)'); assert.ok(chapter.cover_path.startsWith('gwcontent/'));
  const image = await evaluate('window.api.imageDataUrl(' + json(chapter.cover_path) + ')'); assert.ok(image?.startsWith('data:image/png;base64,'));
  assert.equal(createHash('sha256').update(Buffer.from(image.split(',')[1], 'base64')).digest('hex'), hash(path.join(directory, 'images/ui.png')));
  const pronunciation = await evaluate('window.api.getPronunciation(1)'); const audio = await evaluate('window.api.audioDataUrl(' + json(pronunciation.audio_us) + ')'); assert.ok(audio?.startsWith('data:audio/wav;base64,'));
  const digest = chapter.cover_path.split('/')[1]; assert.equal(fs.existsSync(path.join(contentPackages, 'raw', digest, 'images/ui.png')), false, 'RAW image must remain in its original directory');
}
async function home(expected = '原始目录小词书') { await open('/', '!!document.querySelector("#book")'); assert.ok((await evaluate('document.querySelector("#book").innerText')).includes(expected)); }
async function selection(state) {
  const d = state.directories;
  await management(); assert.equal(await evaluate('window.api.contentAvailable()'), false); const initial = await status();
  nextDirectory = null; await click('选择资源目录'); await waitFor('document.querySelector(".cp-directory-feedback[role=status]")?.textContent.includes("取消选择")'); assert.deepEqual(await status(), initial);
  nextDirectory = path.join(profile, 'missing-source'); await click('选择资源目录'); await waitFor('!!document.querySelector(".cp-directory-feedback[role=alert]")&&' + idle); assert.deepEqual(await status(), initial);
  await preview(d.empty); assert.equal(await evaluate('Array.from(document.querySelectorAll(".cp-directory-preview button")).find(el=>el.textContent.trim()==="确认载入").disabled'), true); await click('取消载入');
  cases.push({ name: 'native-picker-cancel-missing-and-empty-directory-keep-original-content', ok: true });
  await preview(d.raw, '解包资料目录');
  const text = await evaluate('document.querySelector(".cp-directory-preview").innerText'); assert.ok(text.includes('3 个词') && text.includes('1 个章节') && text.includes('1 句台词'));
  assert.equal(text.includes('SQLite'), false, 'RAW preview uses user-facing wording');
  assert.equal(/同目录基础包已跳过|同目录基础包.*已跳过/u.test(text), false, 'RAW-only directory must not claim that a nonexistent base package was skipped');
  assert.equal(await evaluate('window.api.contentAvailable()'), false); await inspect('raw-preview-1024x768'); await capture('01-raw-preview', '.cp-directory-preview');
  win.setContentSize(1024, 600); await reachable('.cp-directory-preview .gw-actions button:last-child'); await inspect('raw-preview-actions-1024x600'); await capture('02-raw-preview-actions-1024x600');
  await click('取消载入'); assert.deepEqual(await status(), initial); win.setContentSize(1024, 768);
  await preview(d.raw); await confirm(); assert.equal((await status()).raw.path, d.raw); assert.equal(await evaluate('window.api.contentAvailable()'), true);
  await mediaCheck(d.raw); await home(); await inspect('raw-hot-home-1024x768'); await capture('03-raw-hot-home', '.gw-home-grid');
  await open('/browse?chapterId=101&questId=1001', '!!document.querySelector(".gw-line")&&!!document.querySelector("img.gw-cover")?.naturalWidth');
  assert.ok((await evaluate('document.querySelector(".gw-line").innerText')).includes('自由从一场旅行开始'));
  await inspect('raw-hot-browse-1024x768'); await capture('04-raw-hot-browse', 'img.gw-cover');
  cases.push({ name: 'raw-preview-cancel-and-confirm-hot-activates-home-dialogue-and-direct-media', ok: true });
  await management(); const dialogCount = dialogs.length; await click('重新扫描'); await waitFor('!!document.querySelector(".cp-directory-preview")&&' + idle); assert.equal(dialogs.length, dialogCount); await click('取消载入');
  const beforeChanged = await status(); await preview(d.changed); fs.appendFileSync(path.join(d.changed, 'content.db'), 'changed after preview', 'utf8'); await confirm();
  assert.equal((await status()).raw.path, beforeChanged.raw.path); assert.equal(await evaluate('!!document.querySelector(".cp-directory-result [data-resource-raw-status=error] [role=alert]")'), true);
  assert.equal(await evaluate('window.api.contentAvailable()'), true); await inspect('changed-raw-keeps-source'); await capture('05-changed-raw-keeps-source', '.cp-directory-result');
  cases.push({ name: 'raw-rescan-does-not-open-picker-and-changed-preview-retains-current-source', ok: true });
  await preview(d.packages, '内容包目录'); assert.equal(await evaluate('document.querySelectorAll(".cp-directory-preview [data-resource-package-status=ready]").length'), 3); assert.equal(await evaluate('document.querySelectorAll(".cp-directory-preview [data-resource-package-status=error]").length'), 2);
  await inspect('package-directory-preview'); await capture('06-package-directory-preview', '.cp-directory-preview'); await click('取消载入'); assert.equal((await packages()).filter(item => item.id === 'ui.directory.words').length, 0);
  await preview(d.packages); await confirm(); assert.equal((await status()).packageDirectory, d.packages);
  assert.ok((await packages()).some(item => item.id === 'ui.directory.words' && item.status === 'active')); assert.ok(!(await packages()).some(item => item.status === 'pending'));
  assert.equal(await evaluate('document.querySelectorAll(".cp-directory-result [data-resource-load-status=error]").length'), 2);
  await home('目录载入小词书'); await inspect('package-hot-home'); await capture('07-package-hot-home', '.gw-home-grid');
  await open('/reading?unitId=' + encodeURIComponent(state.reading.unitId), '!!document.querySelector("img.rd-banner")?.naturalWidth&&!!document.querySelector(".rd-question")');
  assert.equal(await evaluate('document.querySelector("img.rd-banner").naturalWidth'), 1600); assert.equal(await evaluate('document.querySelector("img.rd-banner").naturalHeight'), 400);
  await inspect('package-reading-hot'); await capture('08-package-reading-hot', '#reading-passage');
  cases.push({ name: 'package-directory-partial-errors-cancel-and-load-all-types-without-restart', ok: true });
  move(path.join(d.packages, 'broken.gwwords'), path.join(profile, 'removed-broken.gwwords')); move(path.join(d.packages, 'incompatible.gwwords'), path.join(profile, 'removed-incompatible.gwwords'));
  fs.copyFileSync(state.extraFile, path.join(d.packages, 'new.gwwords')); await management(); const beforeRescan = dialogs.length;
  await click('重新扫描'); await waitFor('!!document.querySelector(".cp-directory-preview")&&' + idle); assert.equal(dialogs.length, beforeRescan); await confirm();
  assert.ok((await packages()).some(item => item.id === 'ui.rescan.words' && item.status === 'active')); await home('重新扫描小词书');
  cases.push({ name: 'rescan-detects-and-hot-activates-new-package-without-a-dialog', ok: true });
  await management(); await preview(d.mixed, '解包资料与内容包'); assert.equal(await evaluate('document.querySelectorAll(".cp-directory-preview [data-resource-package-status=skipped]").length'), 1);
  assert.equal((await evaluate('document.querySelector(".cp-directory-preview").innerText')).includes('SQLite'), false, 'Mixed directory preview uses user-facing cache wording');
  assert.ok((await evaluate('document.querySelector(".cp-directory-preview").innerText')).includes('优先使用原始目录'));
  win.setContentSize(1024, 600); await reachable('.cp-directory-preview .gw-actions button:last-child'); await inspect('mixed-preview-1024x600'); await capture('09-mixed-preview-1024x600'); win.setContentSize(1024, 768);
  await confirm(); assert.equal((await status()).raw.path, d.mixed); assert.equal((await status()).packageDirectory, d.mixed);
  assert.ok(!(await packages()).some(item => item.id === 'ui.directory.base')); await mediaCheck(d.mixed);
  await inspect('mixed-hot-results'); await capture('10-mixed-hot-results', '.cp-directory-result');
  cases.push({ name: 'mixed-directory-prefers-raw-and-skips-embedded-base-without-losing-other-packages', ok: true });
}
async function restart(state) {
  await management(); const current = await status(); assert.equal(current.raw.path, state.directories.mixed); assert.equal(current.raw.status, 'active'); assert.equal(current.packageDirectoryAvailable, true);
  assert.ok((await packages()).some(item => item.id === 'ui.rescan.words' && item.status === 'active')); await mediaCheck(state.directories.mixed);
  await inspect('restart-restores-directories'); await capture('11-restart-restores-directories', '.cp-directories'); await home('重新扫描小词书');
  cases.push({ name: 'actual-electron-restart-restores-source-packages-home-and-raw-media', ok: true });
  move(state.directories.mixed, state.directories.detached);
}
async function disconnected(state) {
  await management(); const current = await status(); assert.equal(current.raw.status, 'error'); assert.equal(current.packageDirectoryAvailable, false);
  assert.ok((await evaluate('document.querySelector(".cp-directory-current").innerText')).includes('暂时不可用'));
  assert.ok((await packages()).some(item => item.id === state.reading.id && item.status === 'active'));
  const before = await packages(); await inspect('disconnected-source-error'); await capture('12-disconnected-source-error', '.cp-directory-current');
  await click('重新扫描'); await waitFor('!!document.querySelector(".cp-directory-feedback[role=alert]")&&' + idle); assert.deepEqual(await packages(), before);
  cases.push({ name: 'missing-saved-directory-is-visible-and-failed-rescan-keeps-cached-package-list', ok: true });
  move(state.directories.detached, state.directories.mixed); await click('重新扫描'); await waitFor('!!document.querySelector(".cp-directory-preview")&&' + idle); await confirm();
  assert.equal((await status()).raw.status, 'active'); assert.equal((await status()).packageDirectoryAvailable, true); assert.equal(await evaluate('window.api.contentAvailable()'), true);
  await mediaCheck(state.directories.mixed); await home('目录载入小词书'); await inspect('restored-source-hot-home'); await capture('13-restored-source-hot-home', '.gw-home-grid');
  cases.push({ name: 'restored-source-rescans-and-becomes-available-without-another-restart', ok: true });
}
async function restored(state) {
  await management(); assert.equal((await status()).raw.status, 'active'); assert.equal(await evaluate('window.api.contentAvailable()'), true);
  await mediaCheck(state.directories.mixed); await inspect('restored-source-after-restart'); await capture('14-restored-source-after-restart', '.cp-directory-current');
  assert.equal(hash(path.join(state.directories.raw, 'content.db')), state.rawSourceSha); assert.equal(hash(path.join(state.directories.mixed, 'content.db')), state.mixedSourceSha);
  cases.push({ name: 'recovered-selection-persists-and-original-raw-databases-are-unchanged', ok: true });
}
(async () => {
  await app.whenReady(); fs.mkdirSync(output, { recursive: true });
  const missingContent = path.join(profile, 'empty-bundled/content.db'); fs.mkdirSync(path.dirname(missingContent), { recursive: true });
  context = loadMain(missingContent, path.join(profile, 'progress.db'), { contentPackagesDir: contentPackages, readingPackagesDir: readingPackages, bundledReadingPackagePath: null });
  await context.load('resource-directory-config').initializeResourceDirectory(); await context.load('content-package-store').initializeContentPackages();
  context.load('progress-db').setSetting('traveler', 'lumine'); context.load('content-db').openContentDb(); context.load('ipc').registerIpc();
  dialog.showOpenDialog = async (...args) => { const options = args.at(-1); assert.deepEqual(options.properties, ['openDirectory']); assert.equal(options.title, '选择资源目录'); assert.notEqual(nextDirectory, undefined, 'Unexpected native picker');
    const selected = nextDirectory; nextDirectory = undefined; dialogs.push({ canceled: selected === null, directory: selected }); return selected === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [selected] }; };
  win = new BrowserWindow({ show: false, width: 1024, height: 768, useContentSize: true, webPreferences: { preload: path.join(root, 'out/preload/index.js'), sandbox: true, contextIsolation: true, spellcheck: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', item => { if (item.level === 'error') errors.push(item.message); }); win.webContents.on('render-process-gone', (_event, item) => errors.push('Renderer gone: ' + item.reason));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (item, callback) => { requests.push(item.url); callback({ cancel: true }); });
  const state = phase === 'selection' ? await generateState() : JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  await ({ selection, restart, disconnected, restored }[phase])(state); assert.deepEqual(requests, []); assert.deepEqual(errors, []);
  const report = { ok: true, phase, pid: process.pid, cases, measurements, screenshots, dialogs, requests, errors, profileIsolation: true, nativePickerOnlyStub: true };
  fs.writeFileSync(path.join(output, 'phase-' + phase + '.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'); console.log(JSON.stringify({ ok: true, phase, cases: cases.length, measurements: measurements.length }));
})().then(() => finish(0), error => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ ok: false, phase, error: error.stack, cases, measurements, screenshots, dialogs, requests, errors }, null, 2) + '\n', 'utf8'); console.error(error); finish(1); });
function finish(code) { win?.destroy(); try { context?.close(); } catch (error) { console.error(error); code = 1; } app.exit(code); }
