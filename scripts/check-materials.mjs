/** Read-only integrity and offline-media audit for the acquired corpus. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { extractFile } = require('@electron/asar');
const project = fileURLToPath(new URL('../', import.meta.url));
const content = path.join(project, 'content');
const sha = b => createHash('sha256').update(b).digest('hex');
const report = JSON.parse(fs.readFileSync(path.join(content, 'materials_manifest.json'), 'utf8'));
const file = path.join(content, 'materials.db');
if (report.database.sha256 !== sha(fs.readFileSync(file)))
    throw Error('materials.db differs from its manifest');
const db = new Database(file, { readonly: true, fileMustExist: true });
db.pragma('query_only=ON');
if (db.pragma('integrity_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length)
    throw Error('Materials database integrity failed');
const count = (sql, ...params) => db.prepare(sql).get(...params).n;
const materialCount = count('SELECT count(*) n FROM materials');
if (materialCount !== report.counts.materials || count('SELECT count(*) n FROM texts') !== materialCount * 2)
    throw Error('Bilingual material counts differ');
for (const source of db.prepare('SELECT name,sha256,raw_gzip FROM sources').iterate())
    if (sha(gunzipSync(source.raw_gzip)) !== source.sha256)
        throw Error('Raw snapshot checksum mismatch: ' + source.name);
for (const t of db.prepare('SELECT material_id,text,paragraphs_json FROM texts').iterate()) {
    const ps = JSON.parse(t.paragraphs_json);
    const lines = t.text.split('\n').filter(l => l.trim());
    if (ps.length !== lines.length || ps.some((p, i) => p.text !== lines[i]))
        throw Error('Paragraph preservation failed: ' + t.material_id);
}
const archive = path.join(content, 'assets.asar');
for (const image of report.images) {
    const relative = image.file_path.replaceAll('\\', '/');
    if (!relative.startsWith('images/reading-headers/') || relative.split('/').includes('..'))
        throw Error('Invalid image path');
    const bytes = fs.existsSync(archive) ? extractFile(archive, relative) : fs.readFileSync(path.join(content, relative));
    if (sha(bytes) !== image.sha256)
        throw Error('Offline artwork checksum mismatch: ' + relative);
    if (image.width / image.height < 1.6 || image.width < 1024 || image.height < 480)
        throw Error('Artwork is not a large landscape image');
}
let matches = null;
const matchReportFile = path.join(content, 'material_match_report.json');
if (!fs.existsSync(matchReportFile))
    throw Error('Missing local vocabulary match index; run npm run content:match');
if (fs.existsSync(matchReportFile)) {
    const r = JSON.parse(fs.readFileSync(matchReportFile, 'utf8'));
    if (r.source_materials_sha256 !== report.database.sha256)
        throw Error('Local vocabulary index is stale');
    const matchFile = path.join(content, 'material_matches.db');
    if (sha(fs.readFileSync(matchFile)) !== r.database.sha256)
        throw Error('Local match checksum mismatch');
    const m = new Database(matchFile, { readonly: true, fileMustExist: true });
    if (m.pragma('integrity_check', { simple: true }) !== 'ok')
        throw Error('Local match index corrupt');
    m.exec("ATTACH DATABASE '" + file.replaceAll("'", "''") + "' AS materials");
    const orphan = m.prepare('SELECT count(*) n FROM word_hits h LEFT JOIN materials.materials t ON t.id=h.material_id WHERE t.id IS NULL').get().n;
    if (orphan)
        throw Error('Local matches reference unknown materials');
    const w = new Database(path.join(content, 'content.db'), { readonly: true, fileMustExist: true });
    const inv = w.prepare('SELECT id,lemma FROM words ORDER BY id').all();
    const forms = w.prepare('SELECT form,word_id FROM word_forms ORDER BY form,word_id').all();
    if (sha(JSON.stringify(forms)) !== r.word_forms_sha256)
        throw Error('Word forms changed after matching');
    if (sha(JSON.stringify(inv)) !== r.word_inventory_sha256)
        throw Error('Word IDs changed after matching');
    w.close();
    m.close();
    matches = r.matched_words;
}
console.log('MATERIALS_AUDIT_OK ' + JSON.stringify({ materials: materialCount, sources: report.counts.sources, wide_artworks: report.images.length, matched_words: matches, graph_warnings: report.graph_warnings.length, empty_english: report.counts.empty_en }));
db.close();
