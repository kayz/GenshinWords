import { externalCacheDirectory } from './lib/cache-directory.mjs';
/** Fetch public corpus snapshots. Runtime code never performs these network requests. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const cacheArg = args.indexOf('--cache');
if (cacheArg < 0 || !args[cacheArg + 1])
    throw new Error('Usage: node scripts/acquire-materials.mjs --cache <absolute staging directory> [--plan-only]');
const cache = await externalCacheDirectory(args[cacheArg + 1], project);
if (!path.isAbsolute(args[cacheArg + 1]))
    throw new Error('--cache must be absolute');
if (cache.startsWith(path.join(project, 'content')))
    throw new Error('Keep download caches outside packaged content');
await fs.mkdir(cache, { recursive: true });
const manifestFile = path.join(cache, 'requests.json');
const requests = new Map();
try {
    for (const r of JSON.parse(await fs.readFile(manifestFile, 'utf8')))
        requests.set(r.name, r);
}
catch (e) {
    if (e.code !== 'ENOENT')
        throw e;
}
function amber(locale, route) {
    const name = locale + '_' + route.replaceAll('/', '_') + '.json';
    const request = { name, url: 'https://gi.yatta.moe/api/v2/' + locale + '/' + route, provider: 'amber', locale, route };
    requests.set(name, request);
    return name;
}
const officialBase = 'https://sg-public-api-static.hoyoverse.com/content_v2_user/app/a1b1f9d3315447cc/';
function official(name, endpoint) {
    const request = { name, url: officialBase + endpoint, provider: 'hoyoverse' };
    requests.set(name, request);
    return name;
}
function artwork(url, subject, metadata) {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext))
        throw new Error('Unsupported art format: ' + url);
    const name = 'art_' + createHash('sha256').update(url).digest('hex').slice(0, 24) + ext;
    requests.set(name, { name, url, binary: true, provider: 'hoyoverse', subject, ...metadata });
}
async function read(name) { return JSON.parse(await fs.readFile(path.join(cache, name), 'utf8')).data; }
async function fetchStage(label, names) {
    const list = [...new Set(names)].map(n => requests.get(n));
    await fs.writeFile(manifestFile, JSON.stringify([...requests.values()], null, 2), { encoding: 'utf8' });
    const stageFile = path.join(cache, 'stage.json');
    await fs.writeFile(stageFile, JSON.stringify(list), { encoding: 'utf8' });
    console.log('STAGE ' + label + ' requests=' + list.length);
    if (args.includes('--plan-only'))
        return;
    await new Promise((resolve, reject) => {
        const child = spawn('pwsh', ['-NoProfile', '-File', path.join(project, 'scripts/fetch-public-data.ps1'), '-RequestsPath', stageFile, '-CacheDirectory', cache], { cwd: project, windowsHide: true, stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(label + ' incomplete; rerun to resume (exit ' + code + ')')));
    });
}
const seeds = [];
for (const lang of ['en', 'chs'])
    for (const kind of ['book', 'avatar', 'quest'])
        seeds.push(amber(lang, kind));
seeds.push(official('official_characters.json', 'getContentList?iAppId=32&iChanId=407&iPageSize=200&iPage=1&sLangKey=en-us'));
seeds.push(official('official_news_1.json', 'getContentList?iAppId=32&iChanId=395&iPageSize=1000&iPage=1&sLangKey=en-us'));
await fetchStage('catalogs', seeds);
if (args.includes('--plan-only'))
    process.exit(0);
const books = Object.values((await read('en_book.json')).items);
const quests = Object.values((await read('en_quest.json')).items);
const avatarCatalog = Object.values((await read('en_avatar.json')).items);
// Traveler elements share base profile/voice records; preserve both siblings once.
const avatars = [...new Map(avatarCatalog.filter(a => !a.beta && (!a.release || a.release <= Date.now() / 1000)).map(a => [String(a.id).split('-')[0], a])).entries()].map(([id, a]) => ({ ...a, id }));
const detail = [];
for (const lang of ['en', 'chs']) {
    for (const b of books)
        detail.push(amber(lang, 'book/' + b.id));
    for (const q of quests)
        detail.push(amber(lang, 'quest/' + q.id));
    for (const a of avatars)
        detail.push(amber(lang, 'avatarFetter/' + a.id));
}
for (const a of avatars)
    detail.push(amber('en', 'avatar/' + a.id));
await fetchStage('books-characters-quests', detail);
const texts = [];
for (const b of books) {
    const info = await read('en_book_' + b.id + '.json');
    for (const v of info.volume ?? [])
        if (v.storyId)
            for (const lang of ['en', 'chs'])
                texts.push(amber(lang, 'readable/Book' + v.storyId));
}
for (const a of avatars) {
    const info = await read('en_avatar_' + a.id + '.json');
    if (info.other?.furnitureId)
        for (const lang of ['en', 'chs'])
            texts.push(amber(lang, 'furniture/' + info.other.furnitureId));
}
// Official website desktop character illustrations are supplied as original wide PNGs.
const officialCharacters = await read('official_characters.json');
if (officialCharacters.list.length !== Number(officialCharacters.iTotal))
    throw new Error('Official character index is paginated; extend acquisition before compiling');
for (const c of officialCharacters.list) {
    const ext = JSON.parse(c.sExt || '{}');
    for (const art of ext['407_1'] ?? [])
        if (art.url)
            artwork(art.url, c.sTitle, { art_kind: 'official_character_desktop', official_info_id: c.iInfoId, official_channel_ids: c.sChanId, source_page: 'https://genshin.hoyoverse.com/en/character/' + ({ 403: 'mondstadt', 404: 'liyue', 405: 'inazuma', 406: 'sumeru', 653: 'fontaine', 934: 'natlan', 1221: 'snezhnaya' }[c.sChanId.find(v => v !== '407')] || 'mondstadt'), source_field: '407_1', original_name: art.name });
}
const news = await read('official_news_1.json');
for (const n of news.list ?? [])
    if (/wallpaper/i.test(n.sTitle)) {
        texts.push(official('official_news_' + n.iInfoId + '.json', 'getContent?iAppId=32&iInfoId=' + n.iInfoId + '&sLangKey=en-us'));
    }
await fetchStage('reading-texts-companion-dialogues', texts);
for (const request of [...requests.values()])
    if (/^official_news_\d+\.json$/.test(request.name) && request.name !== 'official_news_1.json') {
        const news = await read(request.name);
        // Only original illustration URLs from an official wallpaper release; do not use arbitrary news thumbnails.
        const urls = [...String(news.sContent || '').matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1].replaceAll('&amp;', '&'));
        for (const url of urls)
            if (/\.(png|jpe?g|webp)(\?|$)/i.test(url))
                artwork(url, news.sTitle, { art_kind: 'official_wallpaper', official_info_id: news.iInfoId, source_page: 'https://genshin.hoyoverse.com/en/news/detail/' + news.iInfoId, source_field: 'sContent.img', original_name: news.sTitle });
    }
await fetchStage('official-wide-art', [...requests.values()].filter(r => r.binary).map(r => r.name));
console.log('ACQUISITION_COMPLETE ' + JSON.stringify({ books: books.length, avatars: avatars.length, quests: quests.length, requests: requests.size }));
