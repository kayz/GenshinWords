import { externalCacheDirectory } from './lib/cache-directory.mjs';
/** Acquire original wide-art candidates from the public official website. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf('--cache');
if (i < 0 || !args[i + 1])
    throw Error('Usage: node scripts/acquire-official-art.mjs --cache <download cache>');
const cache = await externalCacheDirectory(args[i + 1], project);
const requests = new Map();
const manifest = path.join(cache, 'art-requests.json');
try {
    for (const r of JSON.parse(await fs.readFile(manifest, 'utf8')))
        requests.set(r.name, r);
}
catch (e) {
    if (e.code !== 'ENOENT')
        throw e;
}
const base = 'https://sg-public-api-static.hoyoverse.com/content_v2_user/app/a1b1f9d3315447cc/';
function request(name, endpoint) { requests.set(name, { name, url: base + endpoint, provider: 'hoyoverse' }); return name; }
async function read(name) { return JSON.parse(await fs.readFile(path.join(cache, name), 'utf8')).data; }
async function stage(label, names) { await fs.writeFile(manifest, JSON.stringify([...requests.values()], null, 2), { encoding: 'utf8' }); const file = path.join(cache, 'art-stage.json'); await fs.writeFile(file, JSON.stringify([...new Set(names)].map(n => requests.get(n))), { encoding: 'utf8' }); console.log('ART_STAGE ' + label + ' ' + names.length); await new Promise((resolve, reject) => { const child = spawn('pwsh', ['-NoProfile', '-File', path.join(project, 'scripts/fetch-public-data.ps1'), '-RequestsPath', file, '-CacheDirectory', cache, '-Concurrency', '2'], { cwd: project, windowsHide: true, stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(label + ' failed; resume with the same cache'))); }); }
const seed = [request('official_characters.json', 'getContentList?iAppId=32&iChanId=407&iPageSize=200&iPage=1&sLangKey=en-us'), request('official_art_news_page_1.json', 'getContentList?iAppId=32&iChanId=395&iPageSize=300&iPage=1&sLangKey=en-us')];
await stage('catalogs', seed);
const first = await read(seed[1]);
const pages = [];
for (let p = 2; p <= Math.ceil(Number(first.iTotal) / 300); p++)
    pages.push(request('official_art_news_page_' + p + '.json', 'getContentList?iAppId=32&iChanId=395&iPageSize=300&iPage=' + p + '&sLangKey=en-us'));
await stage('news-index', pages);
const seen = new Set();
const details = [];
for (const name of [seed[1], ...pages])
    for (const n of (await read(name)).list ?? [])
        if (/wallpaper/i.test(n.sTitle) && !seen.has(n.iInfoId)) {
            seen.add(n.iInfoId);
            details.push(request('official_news_' + n.iInfoId + '.json', 'getContent?iAppId=32&iInfoId=' + n.iInfoId + '&sLangKey=en-us'));
        }
await stage('wallpaper-releases', details);
function artwork(url, subject, metadata) {
    if (url.startsWith('//'))
        url = 'https:' + url;
    if (url.startsWith('http:'))
        url = 'https:' + url;
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext))
        return;
    const name = 'art_' + createHash('sha256').update(url).digest('hex').slice(0, 24) + ext;
    requests.set(name, { name, url, binary: true, provider: 'hoyoverse', subject, ...metadata });
}
const characters = await read(seed[0]);
if (characters.list.length !== Number(characters.iTotal))
    throw Error('Official character catalog truncated');
for (const c of characters.list) {
    const ext = JSON.parse(c.sExt || '{}');
    for (const a of ext['407_1'] ?? [])
        if (a.url)
            artwork(a.url, c.sTitle, { art_kind: 'official_character_desktop', official_info_id: c.iInfoId, official_channel_ids: c.sChanId, source_page: 'https://genshin.hoyoverse.com/en/character/' + ({ 403: 'mondstadt', 404: 'liyue', 405: 'inazuma', 406: 'sumeru', 653: 'fontaine', 934: 'natlan', 1221: 'snezhnaya' }[c.sChanId.find(v => v !== '407')] || 'mondstadt'), source_field: '407_1', original_name: a.name });
}
for (const name of details) {
    const n = await read(name);
    for (const m of String(n.sContent || '').matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi))
        artwork(m[1].replaceAll('&amp;', '&'), n.sTitle, { art_kind: 'official_wallpaper', official_info_id: n.iInfoId, source_page: 'https://genshin.hoyoverse.com/en/news/detail/' + n.iInfoId, source_field: 'sContent.img', original_name: n.sTitle });
}
await stage('official-originals', [...requests.values()].filter(r => r.binary).map(r => r.name));
console.log('OFFICIAL_ART_COMPLETE ' + JSON.stringify({ character_records: characters.list.length, wallpaper_releases: seen.size, original_candidates: [...requests.values()].filter(r => r.binary).length }));
