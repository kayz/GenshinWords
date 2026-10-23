const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/practice-fixture.cjs');

function addSpeakers(f) {
  const db = new Database(f.content.openContentDb().name);
  db.exec("CREATE TABLE speakers(name TEXT PRIMARY KEY,image_path TEXT,icon_path TEXT,image_kind TEXT);" +
    "INSERT INTO speakers VALUES('Paimon','portraits/paimon.webp',NULL,'portrait')," +
    "('Landscape character','landscapes/activity.webp',NULL,'landscape'),('Icon only',NULL,'icons/avatar.webp',NULL);");
  db.close();
}
test('词卡仅使用标为人物立绘的素材，支持中英文角色名', t => {
  const f = fixture(t);
  addSpeakers(f);
  const expected = { name: '派蒙', imagePath: 'portraits/paimon.webp' };
  assert.deepEqual(f.content.getSpeakerPortrait('Paimon'), expected);
  assert.deepEqual(f.content.getSpeakerPortrait('派蒙'), expected);
  assert.deepEqual(f.content.getWordExamples(3)[0].portrait, expected);
  assert.equal(f.content.getSpeakerPortrait('Landscape character'), null);
  assert.equal(f.content.getSpeakerPortrait('Icon only'), null);
  assert.equal(f.content.getSpeakerPortrait('Unknown NPC'), null);
});
test('收藏复习关联原说话人立绘，不改变收录原句快照', t => {
  const f = fixture(t);
  addSpeakers(f);
  const collected = f.collect(5, 'Extra');
  const before = f.progress.openProgressDb().prepare('SELECT source_json FROM collected_words WHERE word_id=?').get(collected.word.id).source_json;
  const example = f.context.load('collections').getCollectionReview(collected.word.id)[0];
  assert.deepEqual(example.portrait, { name: '派蒙', imagePath: 'portraits/paimon.webp' });
  assert.equal(example.text_en, 'Extra matters here. ');
  const after = f.progress.openProgressDb().prepare('SELECT source_json FROM collected_words WHERE word_id=?').get(collected.word.id).source_json;
  assert.equal(after, before);
});
test('旧资料缺少角色或立绘类型字段时返回空值，交由页面显示所选旅行者', t => {
  const f = fixture(t);
  assert.equal(f.content.getSpeakerPortrait('Paimon'), null);
  const db = new Database(f.content.openContentDb().name);
  db.exec("CREATE TABLE speakers(name TEXT PRIMARY KEY,image_path TEXT); INSERT INTO speakers VALUES('Paimon','legacy-art.webp');");
  db.close();
  assert.equal(f.content.getSpeakerPortrait('Paimon'), null);
});

test('旅行者选择动态改变泛指主角的立绘与头像，固定角色和原文保持原样', t => {
  const f=fixture(t); addSpeakers(f);
  const db=new Database(f.contentPath);
  db.exec("INSERT INTO speakers VALUES('Traveler',NULL,'female-icon.webp',NULL),('Aether','fixed-aether.webp','fixed-aether-icon.webp','portrait'),('Lumine','fixed-lumine.webp','fixed-lumine-icon.webp','portrait'); UPDATE dialog_lines SET speaker='Traveler' WHERE id=1;");
  db.close();
  const {TRAVELERS}=f.context.load('../shared/traveler');
  f.progress.setSetting('traveler','aether');
  assert.deepEqual(f.content.getSpeakerPortrait('Traveler'),{name:'空',imagePath:TRAVELERS.aether.portraitPath,traveler:true});
  assert.equal(f.content.listDialogLines(1)[0].speaker_image,TRAVELERS.aether.avatarPath);
  const sourceBefore=f.content.listDialogLines(1)[0].text_en;
  const captured=f.collect(1,'sword');
  const saved=f.progress.openProgressDb().prepare('SELECT source_json FROM collected_words WHERE word_id=?').get(captured.word.id).source_json;
  f.progress.setSetting('traveler','lumine');
  assert.deepEqual(f.content.getSpeakerPortrait('旅行者'),{name:'荧',imagePath:TRAVELERS.lumine.portraitPath,traveler:true});
  assert.equal(f.content.listDialogLines(1)[0].speaker_image,TRAVELERS.lumine.avatarPath);
  assert.equal(f.content.listDialogLines(1)[0].text_en,sourceBefore);
  assert.equal(f.content.getSpeakerPortrait('Aether').imagePath,'fixed-aether.webp');
  assert.equal(f.content.getSpeakerPortrait('Lumine').imagePath,'fixed-lumine.webp');
  assert.equal(f.context.load('collections').getCollectionReview(captured.word.id)[0].portrait.name,'荧');
  assert.equal(f.progress.openProgressDb().prepare('SELECT source_json FROM collected_words WHERE word_id=?').get(captured.word.id).source_json,saved);
  f.progress.closeProgressDb();
  assert.equal(f.progress.getSetting('traveler'),'lumine');
});

test('旅行者设置仅接受空或荧，缺少来源的普通例句继续返回空立绘', t => {
  const f=fixture(t);
  const {handlers}=f.context.load('ipc');
  assert.throws(()=>handlers['settings:set']({},'traveler','paimon'),/空或者荧/);
  handlers['settings:set']({},'traveler','aether');
  assert.equal(f.progress.getSetting('traveler'),'aether');
  assert.equal(f.content.getSpeakerPortrait('unknown'),null);
});

test('剧情头像不使用活动横图，缺头像时交给首字占位；真实icon优先',t=>{
  const f=fixture(t);addSpeakers(f);
  const db=new Database(f.contentPath);
  db.exec("UPDATE dialog_lines SET speaker='Landscape character' WHERE id=1; UPDATE dialog_lines SET speaker='Icon only' WHERE id=2;");
  db.close();
  const lines=f.content.listDialogLines(1);
  assert.equal(lines.find(line=>line.id===1).speaker_image,null);
  assert.equal(lines.find(line=>line.id===2).speaker_image,'icons/avatar.webp');
});

// Synthetic voice artwork fixtures; the packaged source databases remain read-only.
function voiceArtworkFixture(f, options = {}) {
  const fs = require('node:fs'), path = require('node:path');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFfoAAAAASUVORK5CYII=', 'base64');
  const images = path.join(f.directory, 'images'); fs.mkdirSync(images, { recursive: true });
  for (const name of ['mualani.png', 'mualani-card.png', 'aether.png', 'lumine.png']) fs.writeFileSync(path.join(images, name), image);
  const db = new Database(f.contentPath);
  db.exec("ALTER TABLE quests ADD COLUMN cover_path TEXT;" +
    "INSERT INTO chapters(id,type,title_en,title_chs,version,cover_path) VALUES(-10000102,'voice','Mualani','玛拉妮','5.0','activity.webp')," +
    "(-10000005,'voice','Aether','空','1.0','activity.webp'),(-10000007,'voice','Lumine','荧','1.0','activity.webp')," +
    "(-19999999,'voice','Unknown voice','未收录角色','1.0','activity.webp');" +
    "INSERT INTO quests(id,chapter_id,title_en,title_chs,cover_path) VALUES(20,-10000102,'Hello','你好','quest-activity.webp');" +
    "CREATE TABLE speakers(name TEXT PRIMARY KEY,image_path TEXT,image_kind TEXT,image_source_url TEXT);" +
    "INSERT INTO speakers VALUES('Aether','aether.png','portrait','https://example.test/aether'),('Lumine','lumine.png','portrait','https://example.test/lumine');");
  if (options.portrait !== false) db.exec("INSERT INTO speakers VALUES('Mualani','mualani-card.png','portrait','https://example.test/mualani');");
  db.close();
  const materials = new Database(path.join(f.directory, 'materials.db'));
  materials.exec("CREATE TABLE artwork(id TEXT PRIMARY KEY,subject TEXT,file_path TEXT,source_page TEXT,kind TEXT,width INTEGER,height INTEGER);" +
    "CREATE TABLE artwork_scopes(artwork_id TEXT,scope_kind TEXT,scope_id TEXT);" +
    "CREATE TABLE collections(id TEXT PRIMARY KEY,metadata_json TEXT);");
  materials.prepare('INSERT INTO collections VALUES(?,?)').run('character:10000102', JSON.stringify({ name: 'Mualani' }));
  materials.prepare('INSERT INTO artwork VALUES(?,?,?,?,?,?,?)').run('official', options.subject || 'Mualani',
    'images/' + (options.missing ? 'missing.png' : 'mualani.png'), 'https://genshin.hoyoverse.com/en/character/natlan',
    'official_character_desktop', 2154, 1320);
  materials.prepare('INSERT INTO artwork_scopes VALUES(?,?,?)').run('official','character','10000102');
  materials.close();
}

test('语音章节与任务只在视图替换为本人官方横图，原数据库保持不变', t => {
  const f = fixture(t); voiceArtworkFixture(f);
  const raw = f.content.openContentDb();
  const chapterBefore = raw.prepare('SELECT * FROM chapters WHERE id=-10000102').get();
  const questBefore = raw.prepare('SELECT * FROM quests WHERE id=20').get();
  const list = f.content.listChapters(undefined, 'voice');
  const chapter = list.find(item => item.id === -10000102);
  assert.equal(chapter.cover_path, 'mualani.png');
  assert.equal(chapter.cover_match, 'official_character_desktop_verified');
  assert.deepEqual(chapter.cover_focus, { x: .5, y: .35 });
  assert.equal(f.content.getChapter(-10000102).cover_path, chapter.cover_path);
  assert.equal(f.content.listQuests(-10000102)[0].cover_path, chapter.cover_path);
  assert.equal(f.content.getQuestChapter(20).quest.cover_path, chapter.cover_path);
  assert.deepEqual(raw.prepare('SELECT * FROM chapters WHERE id=-10000102').get(), chapterBefore);
  assert.deepEqual(raw.prepare('SELECT * FROM quests WHERE id=20').get(), questBefore);
});

test('错误角色的scope图片不冒充本人，缺图也不沿用活动图', t => {
  const f = fixture(t); voiceArtworkFixture(f, { subject: 'Lynette', portrait: false });
  assert.equal(f.content.getChapter(-10000102).cover_path, null);
  assert.equal(f.content.listQuests(-10000102)[0].cover_path, null);
  assert.equal(f.content.getChapter(-19999999).cover_path, null);
  assert.equal(f.content.getChapter(1).cover_path, '');
});

test('官方横图文件缺失时只用同角色portrait，固定空荧不随全局选择互换', t => {
  const f = fixture(t); voiceArtworkFixture(f, { missing: true });
  const chapter = f.content.getChapter(-10000102);
  assert.equal(chapter.cover_path, 'mualani-card.png');
  assert.equal(chapter.cover_match, 'same_character_portrait_fallback');
  for (const traveler of ['aether','lumine']) {
    f.progress.setSetting('traveler', traveler);
    assert.equal(f.content.getChapter(-10000005).cover_path, 'aether.png');
    assert.equal(f.content.getChapter(-10000007).cover_path, 'lumine.png');
  }
});

test('4:1的CSS对齐由真实图片尺寸换算，横图和竖卡均保留脸部焦点', t => {
  const f = fixture(t);
  const { coverObjectPosition } = f.context.load('../shared/cover-focus');
  for (const { width, height, y } of [{ width: 2154, height: 1320, y: .35 }, { width: 900, height: 1600, y: .3 }]) {
    const position = coverObjectPosition(width, height, { x: .5, y });
    const cropHeight = width / 4;
    assert.ok(Math.abs((height - cropHeight) * position.y + cropHeight / 2 - height * y) < .001);
    assert.notEqual(position.y, y, 'A source focal point is not the CSS alignment ratio');
  }
  const portraitPosition = coverObjectPosition(900,1600,{x:.5,y:.3});
  const top = (1600 - 225) * portraitPosition.y;
  assert.ok(top < 400 && top + 225 > 550, 'The reviewed traveler cards retain the complete face');
  assert.deepEqual(coverObjectPosition(4000,500,{x:1,y:.5}),{x:1,y:.5});
  assert.deepEqual(coverObjectPosition(0,0,{x:.5,y:.5}),{x:.5,y:.5});
});
