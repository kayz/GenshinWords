import { plainText } from './lib/material-text.mjs';
/** Build literal vocabulary candidates from local resources only; no practice/UI changes. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const project = fileURLToPath(new URL('../', import.meta.url));
const content = path.join(project, 'content');
const sha = b => createHash('sha256').update(b).digest('hex');
const materialsFile = path.join(content, 'materials.db');
const wordsFile = path.join(content, 'content.db');
const library = new Database(materialsFile, { readonly: true, fileMustExist: true });
const words = new Database(wordsFile, { readonly: true, fileMustExist: true });
library.pragma('query_only=ON');
words.pragma('query_only=ON');
const output = path.join(content, 'material_matches.db');
const temporary = output + '.tmp';
if (fs.existsSync(temporary))
    fs.unlinkSync(temporary);
const db = new Database(temporary);
db.pragma('journal_mode=DELETE');
db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE word_hits(material_id TEXT NOT NULL,word_id INTEGER NOT NULL,occurrences INTEGER NOT NULL,form TEXT NOT NULL,source_part TEXT NOT NULL,node_id TEXT NOT NULL,option_index INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,PRIMARY KEY(material_id,word_id));CREATE INDEX hits_word ON word_hits(word_id);`);
const root = { next: new Map(), forms: new Set() };
const formIds = new Map();
const normalize = s => s.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
function tokens(s) { return [...s.matchAll(/[\p{L}\p{N}]+(?:['’‘][\p{L}\p{N}]+)*/gu)].map(m => ({ value: normalize(m[0]), start: m.index, end: m.index + m[0].length })); }
function add(form, id) {
    const key = normalize(form);
    const ts = tokens(key);
    if (!ts.length)
        return;
    if (!formIds.has(key))
        formIds.set(key, new Set());
    formIds.get(key).add(id);
    let node = root;
    for (const t of ts) {
        if (!node.next.has(t.value))
            node.next.set(t.value, { next: new Map(), forms: new Set() });
        node = node.next.get(t.value);
    }
    node.forms.add(key);
}
const inventory = words.prepare('SELECT id,lemma FROM words ORDER BY id').all();
const formInventory = words.prepare('SELECT form,word_id FROM word_forms ORDER BY form,word_id').all();
for (const w of inventory)
    add(w.lemma, w.id);
for (const f of formInventory)
    add(f.form, f.word_id);
const put = db.prepare('INSERT INTO word_hits VALUES(?,?,?,?,?,?,?,?,?)');
let scanned = 0;
let occurrences = 0;
const found = new Set();
const kindWords = new Map();
function scan(text, hits, part, nodeId = '', optionIndex = -1) {
    const visible = text.replace(/\{([^{}]*)\}/g, (full, inside) => { const marker = /^[MF]#/.test(inside); return marker ? '   ' + inside.slice(2) + ' ' : ' '.repeat(full.length); });
    const ts = tokens(visible);
    for (let i = 0; i < ts.length; i++) {
        let node = root;
        for (let j = i; j < ts.length; j++) {
            node = node.next.get(ts[j].value);
            if (!node)
                break;
            if (!node.forms.size)
                continue;
            const surface = normalize(visible.slice(ts[i].start, ts[j].end));
            if (!node.forms.has(surface))
                continue;
            for (const id of formIds.get(surface)) {
                const prior = hits.get(id);
                if (prior)
                    prior.occurrences++;
                else
                    hits.set(id, { occurrences: 1, form: surface, part, nodeId, optionIndex, start: ts[i].start, end: ts[j].end });
            }
        }
    }
}
const nodes = library.prepare("SELECT node_id,options_json FROM dialogue_nodes WHERE material_id=? AND locale='en'");
const narratorLines = library.prepare("SELECT line_index,text FROM narration_lines WHERE material_id=? AND locale='en'");
const batch = [];
function flush() {
    db.transaction(() => {
        for (const item of batch)
            for (const [wordId, h] of item.hits) {
                put.run(item.id, wordId, h.occurrences, h.form, h.part, h.nodeId, h.optionIndex, h.start, h.end);
                occurrences += h.occurrences;
                found.add(wordId);
                if (!kindWords.has(item.kind))
                    kindWords.set(item.kind, new Set());
                kindWords.get(item.kind).add(wordId);
            }
    })();
    batch.length = 0;
}
for (const t of library.prepare("SELECT m.id,m.kind,t.text FROM materials m JOIN texts t ON t.material_id=m.id AND t.locale='en' ORDER BY m.id").iterate()) {
    const hits = new Map();
    if (['quest_dialogue', 'companion_dialogue'].includes(t.kind)) {
        for (const n of nodes.iterate(t.id))
            for (const [index, o] of JSON.parse(n.options_json).entries())
                if (o.text)
                    scan(plainText(o.text), hits, 'dialogue_node', n.node_id, index);
    }
    else if (t.kind === 'quest_narration') {
        for (const n of narratorLines.iterate(t.id))
            scan(n.text, hits, 'narration_line', String(n.line_index));
    }
    else
        scan(t.text, hits, 'text');
    batch.push({ id: t.id, kind: t.kind, hits });
    scanned++;
    if (batch.length >= 250)
        flush();
    if (scanned % 5000 === 0)
        console.log('LOCAL_MATCH_PROGRESS ' + scanned);
}
flush();
const unmatched = inventory.filter(w => !found.has(w.id));
const stats = { schema_version: 1, built_at: new Date().toISOString(), local_only: true, words: inventory.length, matched_words: found.size, unmatched_words: unmatched.length, materials_scanned: scanned, word_material_pairs: db.prepare('SELECT count(*) n FROM word_hits').get().n, occurrences, by_kind: [...kindWords].map(([kind, set]) => ({ kind, matched_words: set.size })), unmatched, source_materials_sha256: sha(fs.readFileSync(materialsFile)), word_inventory_sha256: sha(JSON.stringify(inventory)), word_forms_sha256: sha(JSON.stringify(formInventory)), policy: 'Literal local word-form candidates only; offsets are UTF-16 indices into normalized plain text, with unrendered control placeholders masked; no level assignment, semantic validation, question generation, or forced text. Dialogue hits reference an individual node/option with branches retained in materials.db.' };
for (const [k, v] of Object.entries({ schema_version: 1, built_at: stats.built_at, source_materials_sha256: stats.source_materials_sha256, word_inventory_sha256: stats.word_inventory_sha256, word_forms_sha256: stats.word_forms_sha256, policy: stats.policy }))
    db.prepare('INSERT INTO meta VALUES(?,?)').run(k, JSON.stringify(v));
if (db.pragma('integrity_check', { simple: true }) !== 'ok')
    throw Error('Match index integrity check failed');
db.close();
library.close();
words.close();
fs.renameSync(temporary, output);
stats.database = { path: 'content/material_matches.db', bytes: fs.statSync(output).size, sha256: sha(fs.readFileSync(output)) };
fs.writeFileSync(path.join(content, 'material_match_report.json'), JSON.stringify(stats, null, 2) + '\n', { encoding: 'utf8' });
console.log('LOCAL_MATCH_COMPLETE ' + JSON.stringify({ ...stats, unmatched: undefined }));
