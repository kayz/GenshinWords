import { externalCacheDirectory } from './lib/cache-directory.mjs';
/** Collect released version artwork from the verified Genshin Impact Official wallpaper collection. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf('--cache');
if (i < 0 || !args[i + 1])
    throw Error('--cache is required');
const cache = await externalCacheDirectory(args[i + 1], project);
const requests = new Map();
const manifest = path.join(cache, 'version-art-requests.json');
try {
    for (const r of JSON.parse(await fs.readFile(manifest, 'utf8')))
        requests.set(r.name, r);
}
catch (e) {
    if (e.code !== 'ENOENT')
        throw e;
}
async function stage(label, names) { await fs.writeFile(manifest, JSON.stringify([...requests.values()], null, 2), { encoding: 'utf8' }); const f = path.join(cache, 'version-art-stage.json'); await fs.writeFile(f, JSON.stringify([...new Set(names)].map(n => requests.get(n))), { encoding: 'utf8' }); console.log('VERSION_ART_STAGE ' + label + ' ' + names.length); await new Promise((resolve, reject) => { const child = spawn('pwsh', ['-NoProfile', '-File', path.join(project, 'scripts/fetch-public-data.ps1'), '-RequestsPath', f, '-CacheDirectory', cache, '-Concurrency', '2'], { cwd: project, windowsHide: true, stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(label + ' failed; rerun to resume'))); }); }
function post(id) { const name = 'official_wallpaper_post_' + id + '.json'; requests.set(name, { name, url: 'https://bbs-api-os.hoyolab.com/community/post/wapi/getPostFull?gids=2&post_id=' + id, provider: 'hoyoverse' }); return name; }
const old = JSON.parse(await fs.readFile(path.join(project, 'content/images/art_manifest.json'), 'utf8'));
const seeds = new Set(['39056688']);
for (const a of old.assets ?? [])
    if (a.width / a.height >= 1.6)
        for (const u of a.official_references ?? []) {
            const m = u.match(/^https:\/\/www\.hoyolab\.com\/article\/(\d+)/);
            if (m)
                seeds.add(m[1]);
        }
const seen = new Set();
let todo = [...seeds];
const posts = [];
let declaredTotal = null;
while (todo.length) {
    const ids = [...new Set(todo)].filter(id => !seen.has(id));
    todo = [];
    if (!ids.length)
        break;
    await stage('official-posts', ids.map(post));
    for (const id of ids) {
        seen.add(id);
        const wrapper = JSON.parse(await fs.readFile(path.join(cache, post(id)), 'utf8')).data.post;
        const p = wrapper.post;
        if (String(p.uid) !== '1015537' || String(wrapper.user.uid) !== '1015537' || wrapper.user.certification?.type !== 1)
            throw Error('Unverified official author on post ' + id);
        if (String(wrapper.collection?.id) !== '526679')
            throw Error('Post is outside official wallpaper collection: ' + id);
        declaredTotal = Number(wrapper.collection.post_num);
        posts.push(wrapper);
        for (const next of [wrapper.collection.last_id, wrapper.collection.next_id])
            if (next && next !== '0' && !seen.has(String(next)))
                todo.push(String(next));
    }
}
if (declaredTotal !== posts.length)
    throw Error('Incomplete official wallpaper collection ' + posts.length + '/' + declaredTotal);
for (const wrapper of posts) {
    const p = wrapper.post;
    for (const [index, img] of (wrapper.image_list ?? []).entries()) {
        if (img.width / img.height < 1.6 || img.width < 1024 || img.height < 480)
            continue;
        const url = img.url;
        const ext = path.extname(new URL(url).pathname).toLowerCase();
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext))
            continue;
        const name = 'art_' + createHash('sha256').update(url).digest('hex').slice(0, 24) + ext;
        requests.set(name, { name, url, binary: true, provider: 'hoyoverse', subject: p.subject, art_kind: 'official_version_wallpaper', official_info_id: p.post_id, official_author_uid: p.uid, official_collection_id: '526679', source_page: 'https://www.hoyolab.com/article/' + p.post_id, source_field: 'image_list[' + index + '].url', original_name: p.subject });
    }
}
await stage('official-wide-originals', [...requests.values()].filter(r => r.binary).map(r => r.name));
console.log('VERSION_ART_COMPLETE ' + JSON.stringify({ official_posts: posts.length, wide_originals: [...requests.values()].filter(r => r.binary).length }));
