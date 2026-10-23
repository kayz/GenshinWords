import { externalCacheDirectory } from './lib/cache-directory.mjs';
/** Compile previously downloaded snapshots only. This script never makes network requests. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { plainText as decode, splitParagraphs as paragraphs } from './lib/material-text.mjs';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sharp = require('sharp');
const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const cacheAt = args.indexOf('--cache');
if (cacheAt < 0 || !args[cacheAt + 1])
    throw Error('Usage: node scripts/build-materials.mjs --cache <download cache>');
const cache = await externalCacheDirectory(args[cacheAt + 1], project);
const requestFile = path.join(cache, 'requests.json');
const requests = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
for (const filename of ['art-requests.json', 'version-art-requests.json']) {
    const auxiliary = path.join(cache, filename);
    if (fs.existsSync(auxiliary))
        for (const r of JSON.parse(fs.readFileSync(auxiliary, 'utf8')))
            if (!requests.some(q => q.name === r.name))
                requests.push(r);
}
const byName = new Map(requests.map(r => [r.name, r]));
const sha = b => createHash('sha256').update(b).digest('hex');
const memo = new Map();
function read(name) {
    if (memo.has(name))
        return memo.get(name);
    if (!byName.has(name))
        throw Error('Unregistered source ' + name);
    const data = JSON.parse(fs.readFileSync(path.join(cache, name), 'utf8')).data;
    memo.set(name, data);
    return data;
}
function source(lang, route) { return lang + '_' + route.replaceAll('/', '_') + '.json'; }
const buildFile = path.join(cache, 'materials.build.db');
if (fs.existsSync(buildFile))
    fs.unlinkSync(buildFile);
const db = new Database(buildFile);
db.pragma('journal_mode=DELETE');
db.pragma('foreign_keys=ON');
db.exec(`
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE sources(name TEXT PRIMARY KEY,provider TEXT NOT NULL,locale TEXT,url TEXT NOT NULL,fetched_at TEXT NOT NULL,sha256 TEXT NOT NULL,raw_gzip BLOB NOT NULL);
CREATE TABLE collections(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title_en TEXT NOT NULL,title_chs TEXT NOT NULL,metadata_json TEXT NOT NULL);
CREATE TABLE materials(id TEXT PRIMARY KEY,kind TEXT NOT NULL,parent_id TEXT NOT NULL REFERENCES collections(id),character_id TEXT,chapter_id INTEGER,quest_id INTEGER,scene_id TEXT,metadata_json TEXT NOT NULL);
CREATE TABLE texts(material_id TEXT NOT NULL REFERENCES materials(id),locale TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,raw_text TEXT NOT NULL,text TEXT NOT NULL,paragraphs_json TEXT NOT NULL,source_name TEXT NOT NULL REFERENCES sources(name),source_page TEXT NOT NULL,path_policy TEXT NOT NULL,PRIMARY KEY(material_id,locale));
CREATE TABLE dialogue_graphs(material_id TEXT NOT NULL REFERENCES materials(id),locale TEXT NOT NULL,init_node TEXT,metadata_json TEXT NOT NULL,PRIMARY KEY(material_id,locale));
CREATE TABLE dialogue_nodes(material_id TEXT NOT NULL,locale TEXT NOT NULL,node_id TEXT NOT NULL,type TEXT NOT NULL,speaker TEXT NOT NULL,options_json TEXT NOT NULL,metadata_json TEXT NOT NULL,PRIMARY KEY(material_id,locale,node_id),FOREIGN KEY(material_id,locale) REFERENCES dialogue_graphs(material_id,locale));
CREATE TABLE dialogue_edges(material_id TEXT NOT NULL,locale TEXT NOT NULL,from_node TEXT NOT NULL,option_index INTEGER NOT NULL,to_node TEXT NOT NULL,PRIMARY KEY(material_id,locale,from_node,option_index),FOREIGN KEY(material_id,locale,from_node) REFERENCES dialogue_nodes(material_id,locale,node_id));
CREATE TABLE narration_lines(material_id TEXT NOT NULL REFERENCES materials(id),locale TEXT NOT NULL,line_index INTEGER NOT NULL,speaker TEXT NOT NULL,raw_text TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(material_id,locale,line_index));
CREATE TABLE artwork(id TEXT PRIMARY KEY,kind TEXT NOT NULL,subject TEXT NOT NULL,file_path TEXT NOT NULL,source_url TEXT NOT NULL,source_page TEXT NOT NULL,source_field TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,has_alpha INTEGER NOT NULL,sha256 TEXT NOT NULL,metadata_json TEXT NOT NULL);
CREATE TABLE artwork_scopes(artwork_id TEXT NOT NULL REFERENCES artwork(id),scope_kind TEXT NOT NULL,scope_id TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(artwork_id,scope_kind,scope_id));
CREATE INDEX materials_kind ON materials(kind);
CREATE INDEX materials_character ON materials(character_id);
CREATE INDEX materials_chapter ON materials(chapter_id);
CREATE INDEX edges_target ON dialogue_edges(material_id,locale,to_node);
`);
const insertSource = db.prepare('INSERT INTO sources VALUES(@name,@provider,@locale,@url,@fetched_at,@sha256,@raw_gzip)');
const sourceErrors = [];
db.transaction(() => {
    for (const r of requests.filter(r => !r.binary)) {
        const file = path.join(cache, r.name);
        const metaFile = file + '.meta.json';
        if (!fs.existsSync(file) || !fs.existsSync(metaFile)) {
            sourceErrors.push(r.name + ': missing');
            continue;
        }
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        const bytes = fs.readFileSync(file);
        if (!meta.ok || meta.sha256 !== sha(bytes) || meta.url !== r.url) {
            sourceErrors.push(r.name + ': invalid hash or URL');
            continue;
        }
        const envelope = JSON.parse(bytes.toString('utf8'));
        if ((r.provider === 'amber' && envelope.response !== 200) || (r.provider === 'hoyoverse' && envelope.retcode !== 0)) {
            sourceErrors.push(r.name + ': invalid envelope');
            continue;
        }
        insertSource.run({ name: r.name, provider: r.provider, locale: r.locale ?? null, url: r.url, fetched_at: meta.fetched_at, sha256: meta.sha256, raw_gzip: gzipSync(bytes) });
    }
})();
if (sourceErrors.length) {
    db.close();
    throw Error('Download incomplete: ' + JSON.stringify(sourceErrors.slice(0, 10)) + ' total=' + sourceErrors.length);
}
const putCollection = db.prepare('INSERT INTO collections VALUES(?,?,?,?,?)');
const putMaterial = db.prepare('INSERT INTO materials VALUES(@id,@kind,@parent_id,@character_id,@chapter_id,@quest_id,@scene_id,@metadata_json)');
const putText = db.prepare('INSERT INTO texts VALUES(@material_id,@locale,@title,@description,@raw_text,@text,@paragraphs_json,@source_name,@source_page,@path_policy)');
const putGraph = db.prepare('INSERT INTO dialogue_graphs VALUES(?,?,?,?)');
const putNode = db.prepare('INSERT INTO dialogue_nodes VALUES(?,?,?,?,?,?,?)');
const putEdge = db.prepare('INSERT INTO dialogue_edges VALUES(?,?,?,?,?)');
const putNarration = db.prepare('INSERT INTO narration_lines VALUES(?,?,?,?,?,?)');
const warnings = [];
function material(id, kind, parent, metadata = {}, ids = {}) { putMaterial.run({ id, kind, parent_id: parent, character_id: ids.character_id ?? null, chapter_id: ids.chapter_id ?? null, quest_id: ids.quest_id ?? null, scene_id: ids.scene_id ?? null, metadata_json: JSON.stringify(metadata) }); }
function text(id, locale, title, description, raw, src, page, policy = 'original') {
    if (!byName.has(src))
        throw Error('Missing source reference ' + src);
    const clean = decode(raw);
    putText.run({ material_id: id, locale, title: decode(title), description: decode(description), raw_text: String(raw ?? ''), text: clean, paragraphs_json: JSON.stringify(paragraphs(clean)), source_name: src, source_page: page, path_policy: policy });
}
function graph(id, locale, g) {
    const { items = {}, ...meta } = g;
    const init = g.initDialog == null ? null : String(g.initDialog);
    putGraph.run(id, locale, init, JSON.stringify(meta));
    for (const [nodeId, n] of Object.entries(items)) {
        const { text: options = [], type = '', role = '', ...extra } = n;
        putNode.run(id, locale, nodeId, type, role, JSON.stringify(options), JSON.stringify(extra));
    }
    for (const [nodeId, n] of Object.entries(items))
        for (const [i, option] of (n.text ?? []).entries())
            if (option.next != null)
                putEdge.run(id, locale, nodeId, i, String(option.next));
    // A preview follows one source branch. All other options remain in the graph.
    let current = init;
    const visited = new Set();
    const lines = [];
    let previous = '';
    while (current && current !== 'finish' && items[current] && !visited.has(current)) {
        visited.add(current);
        const n = items[current];
        const option = n.text?.[0];
        if (!option)
            break;
        const value = decode(option.text);
        const line = n.role ? decode(n.role) + ': ' + value : value;
        if (value.trim() && line !== previous) {
            lines.push(line);
            previous = line;
        }
        current = option.next == null ? null : String(option.next);
    }
    if (init && !items[init])
        warnings.push({ kind: 'missing_initial_node', material: id, locale, init });
    if (current && current !== 'finish' && !items[current])
        warnings.push({ kind: 'external_or_missing_node', material: id, locale, node: current });
    if (current && visited.has(current))
        warnings.push({ kind: 'cycle_in_preview', material: id, locale, node: current });
    return lines.join('\n');
}
const books = Object.values(read('en_book.json').items);
const questCatalog = Object.values(read('en_quest.json').items);
const avatarCatalog = Object.values(read('en_avatar.json').items);
const avatars = [...new Map(avatarCatalog.filter(a => !a.beta && (!a.release || a.release <= Date.now() / 1000)).map(a => [String(a.id).split('-')[0], a])).entries()].map(([id, a]) => ({ ...a, id }));
const chsAvatars = new Map(Object.values(read('chs_avatar.json').items).map(a => [String(a.id).split('-')[0], a]));
db.transaction(() => {
    for (const b of books) {
        const en = read(source('en', 'book/' + b.id));
        const chs = read(source('chs', 'book/' + b.id));
        const parent = 'book-series:' + b.id;
        putCollection.run(parent, 'book', en.name ?? '', chs.name ?? '', JSON.stringify({ source_id: b.id, volume_count: en.volume?.length ?? 0 }));
        for (const v of en.volume ?? []) {
            if (!v.storyId) {
                warnings.push({ kind: 'book_without_readable_id', book: b.id, volume: v.id });
                continue;
            }
            const id = 'book:' + b.id + ':' + v.id + ':' + v.storyId;
            material(id, 'book', parent, { book_id: b.id, volume_id: v.id, story_id: v.storyId });
            for (const lang of ['en', 'chs']) {
                const localized = lang === 'en' ? v : (chs.volume ?? []).find(c => c.id === v.id);
                const src = source(lang, 'readable/Book' + v.storyId);
                const original = read(src);
                if (typeof original !== 'string')
                    throw Error('Readable is not a text string: ' + src);
                text(id, lang, localized?.name ?? '', localized?.description ?? '', original, src, 'https://gi.yatta.moe/' + lang + '/archive/book/' + b.id);
            }
        }
    }
    for (const a of avatars) {
        const parent = 'character:' + a.id;
        putCollection.run(parent, 'character', a.name, chsAvatars.get(a.id)?.name ?? '', JSON.stringify(a));
        const fetters = { en: read(source('en', 'avatarFetter/' + a.id)), chs: read(source('chs', 'avatarFetter/' + a.id)) };
        for (const [key, entry] of Object.entries(fetters.en.story ?? {})) {
            for (const variant of ['', '2']) {
                if (variant && !entry.text2)
                    continue;
                const id = 'character-story:' + a.id + ':' + key + (variant ? ':variant2' : '');
                material(id, 'character_story', parent, { source_key: key, variant: variant || '1' }, { character_id: a.id });
                for (const lang of ['en', 'chs']) {
                    const v = fetters[lang].story?.[key] ?? {};
                    text(id, lang, v['title' + variant] || v.title || '', v.tips ?? '', v['text' + variant] ?? '', source(lang, 'avatarFetter/' + a.id), 'https://gi.yatta.moe/' + lang + '/archive/avatar/' + a.id + '?mode=story');
                }
            }
        }
        for (const [key, entry] of Object.entries(fetters.en.quotes ?? {})) {
            const id = 'voice:' + a.id + ':' + key;
            material(id, 'voice', parent, { source_key: key, audio_id: entry.audio ?? null }, { character_id: a.id });
            for (const lang of ['en', 'chs']) {
                const indexed = fetters[lang].quotes?.[key];
                const v = indexed?.audio === entry.audio ? indexed : (Object.values(fetters[lang].quotes ?? {}).find(q => q.audio === entry.audio) ?? {});
                text(id, lang, v.title ?? '', v.tips ?? '', v.text ?? '', source(lang, 'avatarFetter/' + a.id), 'https://gi.yatta.moe/' + lang + '/archive/avatar/' + a.id + '?mode=quotes');
            }
        }
        const avatar = read(source('en', 'avatar/' + a.id));
        const furniture = avatar.other?.furnitureId;
        if (!furniture)
            continue;
        const companion = { en: read(source('en', 'furniture/' + furniture)), chs: read(source('chs', 'furniture/' + furniture)) };
        const cp = 'companion:' + furniture;
        putCollection.run(cp, 'companion', a.name, chsAvatars.get(a.id)?.name ?? '', JSON.stringify({ character_id: a.id, furniture_id: furniture }));
        for (const [key, story] of Object.entries(companion.en.story ?? {}))
            for (const [index, g] of (story.taskData ?? []).entries()) {
                const id = cp + ':' + story.id + ':' + index;
                material(id, 'companion_dialogue', cp, { source_key: key, story_id: story.id, graph_index: index }, { character_id: a.id, scene_id: String(story.id) });
                for (const lang of ['en', 'chs']) {
                    const st = Object.values(companion[lang].story ?? {}).find(s => s.id === story.id);
                    const localGraph = st?.taskData?.[index] ?? {};
                    const preview = graph(id, lang, localGraph);
                    text(id, lang, companion[lang].name ?? '', '', preview, source(lang, 'furniture/' + furniture), 'https://gi.yatta.moe/' + lang + '/archive/furniture/' + furniture, 'source-first-branch-preview');
                }
            }
    }
})();
console.log('COMPILE books and character materials complete');
for (const q of questCatalog) {
    const localized = { en: read(source('en', 'quest/' + q.id)), chs: read(source('chs', 'quest/' + q.id)) };
    const parent = 'quest-chapter:' + q.id;
    db.transaction(() => {
        putCollection.run(parent, 'quest_chapter', localized.en.info?.chapterTitle ?? '', localized.chs.info?.chapterTitle ?? '', JSON.stringify({ source_id: q.id, type: q.type, chapter_number: q.chapterNum }));
        for (const story of Object.values(localized.en.storyList ?? {})) {
            const localizedStories = { en: story, chs: Object.values(localized.chs.storyList ?? {}).find(s => s.id === story.id) };
            for (const step of Object.values(story.story ?? {})) {
                const localizedSteps = { en: step, chs: Object.values(localizedStories.chs?.story ?? {}).find(s => s.id === step.id) };
                for (const [i, g] of (step.taskData ?? []).entries()) {
                    const id = 'quest:' + q.id + ':' + story.id + ':' + step.id + ':task:' + i;
                    material(id, 'quest_dialogue', parent, { step_id: step.id, graph_index: i, is_hidden: step.isHidden ?? false }, { chapter_id: q.id, quest_id: story.id, scene_id: String(step.id) });
                    for (const lang of ['en', 'chs']) {
                        const localStep = localizedSteps[lang];
                        const lg = localStep?.taskData?.[i] ?? {};
                        const preview = graph(id, lang, lg);
                        text(id, lang, localStep?.title ?? '', localizedStories[lang]?.info?.description ?? '', preview, source(lang, 'quest/' + q.id), 'https://gi.yatta.moe/' + lang + '/archive/quest/' + q.id, 'source-first-branch-preview');
                    }
                }
                for (const [i, narration] of (step.narratorData ?? []).entries()) {
                    const id = 'quest:' + q.id + ':' + story.id + ':' + step.id + ':narration:' + i;
                    material(id, 'quest_narration', parent, { step_id: step.id, is_warning: narration.isWarning ?? false, trigger: narration.type ?? '', narrator_id: narration.id }, { chapter_id: q.id, quest_id: story.id, scene_id: String(step.id) });
                    for (const lang of ['en', 'chs']) {
                        const lines = localizedSteps[lang]?.narratorData?.[i]?.items ?? [];
                        for (const [lineIndex, line] of lines.entries())
                            putNarration.run(id, lang, lineIndex, line.role ?? '', String(line.text ?? ''), decode(line.text));
                        const raw = lines.map(v => (v.role ? v.role + ': ' : '') + (v.text ?? '')).join('\n');
                        text(id, lang, localizedSteps[lang]?.title ?? '', localizedStories[lang]?.info?.description ?? '', raw, source(lang, 'quest/' + q.id), 'https://gi.yatta.moe/' + lang + '/archive/quest/' + q.id, 'source-narration-order');
                    }
                }
            }
        }
    })();
    // Release each large quest object once it has been compiled.
    memo.delete(source('en', 'quest/' + q.id));
    memo.delete(source('chs', 'quest/' + q.id));
}
console.log('COMPILE quest graphs complete');
const imageOutput = path.join(project, 'content/images/reading-headers');
fs.mkdirSync(imageOutput, { recursive: true });
const imageManifest = [];
const rejected = [];
const putArt = db.prepare('INSERT INTO artwork VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
const putScope = db.prepare('INSERT OR IGNORE INTO artwork_scopes VALUES(?,?,?,?)');
const nameKey = n => String(n).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
for (const r of requests.filter(r => r.binary)) {
    const file = path.join(cache, r.name);
    const metaFile = file + '.meta.json';
    if (!fs.existsSync(file) || !fs.existsSync(metaFile))
        throw Error('Missing artwork ' + r.name);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const bytes = fs.readFileSync(file);
    if (!meta.ok || sha(bytes) !== meta.sha256 || meta.url !== r.url)
        throw Error('Artwork checksum mismatch ' + r.name);
    const info = await sharp(bytes, { failOn: 'error' }).metadata();
    if (!info.width || !info.height || info.width / info.height < 1.6 || info.width < 1024 || info.height < 480) {
        rejected.push({ name: r.name, subject: r.subject, width: info.width, height: info.height, reason: 'not_large_landscape' });
        continue;
    }
    await sharp(bytes, { failOn: 'error' }).stats(); // Full decode before declaring an original offline image usable.
    if (r.art_kind === 'official_wallpaper' && [166531, 159337].includes(Number(r.official_info_id))) {
        rejected.push({ name: r.name, subject: r.subject, width: info.width, height: info.height, reason: Number(r.official_info_id) === 166531 ? 'release_cover_not_reading_illustration' : 'cg_wallpaper_requires_editorial_review' });
        continue;
    }
    const target = path.join(imageOutput, r.name);
    fs.copyFileSync(file, target);
    const relative = 'images/reading-headers/' + r.name;
    const kind = r.art_kind ?? 'official_art';
    putArt.run(r.name, kind, r.subject ?? '', relative, r.url, r.source_page ?? '', r.source_field ?? '', info.width, info.height, info.hasAlpha ? 1 : 0, meta.sha256, JSON.stringify({ official_info_id: r.official_info_id, fetched_at: meta.fetched_at, original_name: r.original_name, original_bytes: true, official_author_uid: r.official_author_uid, official_collection_id: r.official_collection_id }));
    const alias = { columbinahyposelenia: 'columbina' };
    const subjectKey = alias[nameKey(r.subject)] || nameKey(r.subject);
    const matches = avatars.filter(a => nameKey(a.name) === subjectKey);
    const releaseTitle = r.subject?.match(/^The ["“]([^"”]+)["”] wallpaper/i)?.[1];
    if (releaseTitle)
        for (const q of questCatalog)
            if (nameKey(q.chapterTitle) === nameKey(releaseTitle))
                putScope.run(r.name, 'quest_chapter', String(q.id), 'Official wallpaper release title equals chapter title');
    for (const a of matches)
        putScope.run(r.name, 'character', a.id, 'Exact character name in official character catalog');
    imageManifest.push({ id: r.name, kind, subject: r.subject, file_path: relative, source_url: r.url, source_page: r.source_page, source_field: r.source_field, official_info_id: r.official_info_id, original_name: r.original_name, official_author_uid: r.official_author_uid, official_collection_id: r.official_collection_id, fetched_at: meta.fetched_at, width: info.width, height: info.height, has_alpha: info.hasAlpha, sha256: meta.sha256, character_ids: matches.map(a => a.id) });
}
const integrity = db.pragma('integrity_check', { simple: true });
const fk = db.pragma('foreign_key_check');
if (integrity !== 'ok' || fk.length)
    throw Error('Compiled data integrity check failed');
const report = { schema_version: 1, built_at: new Date().toISOString(), network_required_at_runtime: false, snapshot: { book_series: books.length, characters: avatars.length, quest_chapters: questCatalog.length, requests: requests.length }, counts: { sources: db.prepare('SELECT count(*) n FROM sources').get().n, collections: db.prepare('SELECT count(*) n FROM collections').get().n, materials: db.prepare('SELECT count(*) n FROM materials').get().n, texts: db.prepare('SELECT count(*) n FROM texts').get().n, by_kind: db.prepare('SELECT kind,count(*) n FROM materials GROUP BY kind').all(), dialogue_nodes: db.prepare('SELECT count(*) n FROM dialogue_nodes').get().n, dialogue_edges: db.prepare('SELECT count(*) n FROM dialogue_edges').get().n, wide_artworks: imageManifest.length, original_line_breaks_en: db.prepare("SELECT count(*) n FROM texts WHERE locale='en' AND instr(text,char(10))>0").get().n, empty_en: db.prepare("SELECT count(*) n FROM texts WHERE locale='en' AND trim(text)=''").get().n, empty_chs: db.prepare("SELECT count(*) n FROM texts WHERE locale='chs' AND trim(text)=''").get().n }, integrity, foreign_key_violations: fk.length, graph_warnings: warnings, rejected_images: rejected, images: imageManifest, policies: { paragraphs: 'Original LF and blank lines retained; paragraphs_json indexes original nonblank lines, without bilingual line alignment assumptions', dialogues: 'Full graphs and branches retained; texts are labeled first-branch previews, not a canonical answer key', artwork: 'Unmodified official desktop illustrations or official wallpaper releases; minimum 1024x480 and aspect ratio 1.6; no gameplay screenshots', matching: 'Separate local phase; current runtime practice database and user progress remain stable' } };

const legacyDb = new Database(path.join(project, 'content/content.db'), { readonly:true, fileMustExist:true });
const legacyBookIds = new Set(legacyDb.prepare('SELECT id FROM reading_passages').all().map(row=>row.id));
legacyDb.close();
const availableEnglishBooks = db.prepare("SELECT m.id FROM materials m JOIN texts t ON t.material_id=m.id AND t.locale='en' WHERE m.kind='book' AND trim(t.text)<>''").all();
report.quality_summary = {
    english_text_availability: db.prepare("SELECT m.kind,count(*) total,sum(case when trim(t.text)<>'' then 1 else 0 end) nonempty_english FROM materials m JOIN texts t ON t.material_id=m.id AND t.locale='en' GROUP BY m.kind").all(),
    source_blank_book_entries: db.prepare("SELECT count(*) n FROM materials m JOIN texts t ON t.material_id=m.id AND t.locale='en' WHERE m.kind='book' AND trim(t.text)=''").get().n,
    legacy_readable_books_preserved: availableEnglishBooks.filter(row=>legacyBookIds.has(row.id)).length,
    new_nonempty_english_books: availableEnglishBooks.filter(row=>!legacyBookIds.has(row.id)).length,
    header_scope_coverage: db.prepare('SELECT scope_kind,count(distinct scope_id) scopes,count(*) links FROM artwork_scopes GROUP BY scope_kind').all(),
    notes: ['Empty source records and first-branch previews are retained for provenance, not treated as completed exercises.', 'Graph cycle and unresolved-target findings are listed per locale; original nodes remain available.', 'Other thematic header selections need editorial matching.']
};
for(const image of imageManifest) image.credit='HoYoverse / Genshin Impact';

for (const [key, value] of Object.entries({ schema_version: 1, built_at: report.built_at, source: 'Project Amber / HoYoverse official website', policy: report.policies }))
    db.prepare('INSERT INTO meta VALUES(?,?)').run(key, JSON.stringify(value));
db.close();
const contentFile = path.join(project, 'content/materials.db');
const temporary = contentFile + '.tmp';
fs.copyFileSync(buildFile, temporary);
fs.renameSync(temporary, contentFile);
report.database = { path: 'content/materials.db', bytes: fs.statSync(contentFile).size, sha256: sha(fs.readFileSync(contentFile)) };
fs.writeFileSync(path.join(project, 'content/materials_manifest.json'), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8' });
console.log('MATERIALS_READY ' + JSON.stringify({ database: report.database, counts: report.counts, graph_warnings: warnings.length, rejected_images: rejected.length }));
