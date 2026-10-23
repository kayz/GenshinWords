const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const { fixture } = require('./helpers/practice-fixture.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const english = ['The harbor was calm.', 'A sword was ready.', 'The cat was asleep.'];
const chinese = ['港口很平静。', '一把剑已准备好。', '猫睡着了。'];
const sourceText = paragraphs => ({ text: paragraphs.join('\n'), sha256: hash(paragraphs.join('\n')), paragraphs });
const source = { id: 'source-history', title: 'Synthetic history source', url: 'https://example.test/history',
  en: sourceText(english), chs: sourceText(chinese) };
function question(id, expected, paragraph) {
  return { id, type: 'fill', format: '定位信息', prompt: 'Find the word ' + expected + '.', skill: '定位', hint: 'Read carefully.',
    expected, wordLimit: 1, solution: { questionId: id, answer: expected, explanation: '原文直接提供这个词。', evidence: [paragraph] } };
}
function passage(id, paragraphs, questions) {
  return { id, title: id, type: 'reading', level: 'entry', instructions: 'Read the passage.',
    materialId: source.id, textSha256: source.en.sha256, chsTextSha256: source.chs.sha256, bilingualAlignmentVerified: true,
    paragraphMap: paragraphs.map(en => ({ en, chs: [en] })), coverPath: 'assets/history.png', coverFocus: { x: .5, y: .5 },
    sourceTitle: source.title, sourceUrl: source.url, questions, glossary: [], analysis: {
      overview: '合成测试材料的原文解析。', structure: [{ paragraphs, description: '按顺序描述三个事物。' }],
      sentences: [{ paragraph: paragraphs[0], text: english[paragraphs[0] - 1], explanation: '这句话介绍原文中的事物。' }],
    } };
}
async function setup(t) {
  const f = fixture(t, { bundledReadingPackagePath: null });
  const image = await sharp({ create: { width: 4, height: 1, channels: 3, background: '#e8ede6' } }).png().toBuffer();
  const data = { format: 'genshinwords.reading', formatVersion: 1,
    manifest: { id: 'history-test', name: '来源版本测试', version: '1.0.0', minAppVersion: '1.0.0', engineVersion: 1, createdAt: '2026-10-01T00:00:00.000Z' },
    units: [{ kind: 'passage', definition: passage('history-one', [1, 2], [question('old-harbor', 'harbor', 1), question('old-sword', 'sword', 2)]) }],
    legacyGroups: [], sources: [structuredClone(source)], images: [{ path: 'assets/history.png', mimeType: 'image/png', sha256: hash(image),
      sourceTitle: 'Synthetic image', sourceUrl: 'https://example.test/image', dataBase64: image.toString('base64') }] };
  const reading = f.context.load('reading'), store = f.context.load('reading-package-store'), format = f.context.load('reading-package-format');
  async function install(value) {
    const file = path.join(f.directory, value.manifest.version + '.gwreading');
    fs.writeFileSync(file, format.encodeReadingPackage(value));
    return store.importReadingPackage((await store.previewReadingPackageFile(file)).token);
  }
  const answers = value => Object.fromEntries(value.questions.map(q => [q.id, q.expected]));
  const location = f.context.load('reading-location').resolveReadingLocation;
  return { ...f, data, reading, store, format, install, answers, location,
    collection: f.context.load('collections'), collectReading: f.context.load('reading-collection').collectFromReading };
}
function changedSelection(data) {
  const next = structuredClone(data); next.manifest.version = '1.1.0';
  next.units[0].definition = passage('history-one', [2, 3], [question('old-sword', 'sword', 2), question('new-cat', 'cat', 3)]);
  return next;
}
function submit(f, unit, definition, request) { return f.reading.submitReadingPaper(unit.attemptId, f.answers(definition), request); }
function collectHarbor(f, attemptId, paragraph = 1) {
  const original = english[0], start = original.indexOf('harbor');
  return f.collectReading({ attemptId, paragraph, start, end: start + 'harbor'.length });
}

test('versioned reading sources: collection and removed-question rewards reopen their exact old round after a new selection starts', async t => {
  const f = await setup(t); await f.install(f.data);
  const old = f.reading.getReadingUnit('history-one'); submit(f, old, f.data.units[0].definition, 'old-submit');
  collectHarbor(f, old.attemptId);
  const saved = f.collection.getCollectedSource(2);
  assert.equal(saved.attemptId, old.attemptId);
  const oldReward = f.rewards.getRewards().history.find(entry => entry.questionId === 'old-harbor');
  assert.equal(oldReward.attemptId, old.attemptId);
  const next = changedSelection(f.data); await f.install(next);
  const fresh = f.reading.getReadingUnit('history-one', true);
  assert.equal(fresh.paragraphs[0], english[1]); assert.ok(!fresh.questions.some(q => q.id === 'old-harbor'));
  for (const source of [saved, oldReward]) {
    const target = f.location(source.unitId, { attemptId: source.attemptId, paragraph: source.paragraph, questionId: source.questionId });
    const reopened = f.reading.getReadingUnit(target.unitId, false, target.attemptId);
    assert.equal(reopened.attemptId, old.attemptId); assert.equal(reopened.contentVersion, '1.0.0');
    assert.equal(reopened.paragraphs[0], english[0]); assert.ok(reopened.questions.some(q => q.id === 'old-harbor'));
  }
  const oldUrl = f.location('history-one', { questionId: 'old-harbor' });
  assert.equal(oldUrl.attemptId, old.attemptId);
  assert.equal(f.reading.getReadingUnit(oldUrl.unitId, false, oldUrl.attemptId).paragraphs[0], english[0]);
  assert.equal(f.reading.getReadingUnit('history-one').attemptId, fresh.attemptId);
  assert.equal(f.rewards.getRewards().readingTotal, 2);
  assert.equal(f.reading.getReadingUnit('history-one', true, old.attemptId).contentVersion, '1.1.0');
});

test('versioned reading sources: old payloads recover only a uniquely matching original attempt', async t => {
  const f = await setup(t); await f.install(f.data);
  const old = f.reading.getReadingUnit('history-one'); submit(f, old, f.data.units[0].definition, 'before-upgrade');
  collectHarbor(f, old.attemptId);
  const db = f.progress.openProgressDb();
  const source = JSON.parse(db.prepare('SELECT source_json FROM collected_words WHERE word_id=2').get().source_json); delete source.attemptId;
  db.prepare('UPDATE collected_words SET source_json=? WHERE word_id=2').run(JSON.stringify(source));
  const reward = db.prepare("SELECT id,payload_json FROM reward_ledger WHERE item_id='old-harbor'").get();
  const payload = JSON.parse(reward.payload_json); delete payload.attemptId;
  db.prepare('UPDATE reward_ledger SET payload_json=? WHERE id=?').run(JSON.stringify(payload), reward.id);
  await f.install(changedSelection(f.data)); f.reading.getReadingUnit('history-one', true);
  assert.equal(f.collection.getCollectedSource(2).attemptId, old.attemptId);
  assert.equal(f.rewards.getRewards().history.find(entry => entry.questionId === 'old-harbor').attemptId, old.attemptId);
  // A second indistinguishable snapshot cannot establish which attempt produced the old payload.
  const original = db.prepare('SELECT * FROM reading_sessions WHERE id=?').get(old.attemptId);
  db.prepare('INSERT INTO reading_sessions(id,unit_id,created_at,paper_version,draft_json,paper_result_json,answers_viewed_at,content_revision) VALUES(?,?,?,?,?,?,?,?)')
    .run('ambiguous-copy', original.unit_id, original.created_at, 2, original.draft_json, original.paper_result_json, original.answers_viewed_at, original.content_revision);
  db.prepare('INSERT INTO reading_answers(attempt_id,question_id,first_answer,first_correct,last_answer,last_correct,attempts,last_assisted,hint_used,updated_at) ' +
    'SELECT ?,question_id,first_answer,first_correct,last_answer,last_correct,attempts,last_assisted,hint_used,updated_at FROM reading_answers WHERE attempt_id=?')
    .run('ambiguous-copy', old.attemptId);
  assert.equal(f.collection.getCollectedSource(2).attemptId, undefined);
  assert.equal(f.rewards.getRewards().history.find(entry => entry.questionId === 'old-harbor').attemptId, undefined);
  assert.throws(() => f.location('history-one', { questionId: 'old-harbor' }), /唯一恢复/);
});

test('versioned reading sources: a removed passage question restores one draft-only round without inventing answer records', async t => {
  const f = await setup(t); await f.install(f.data);
  const old = f.reading.getReadingUnit('history-one'), draft = { 'old-harbor': 'harbor' };
  f.reading.saveReadingDraft(old.attemptId, draft);
  const next = structuredClone(f.data); next.manifest.version = '1.1.0';
  next.units = [{ kind: 'passage', definition: passage('replacement-reading', [2, 3], [question('replacement-cat', 'cat', 3)]) }];
  await f.install(next);
  const target = f.location(old.id, { questionId: 'old-harbor' });
  assert.equal(target.attemptId, old.attemptId);
  const restored = f.reading.getReadingUnit(target.unitId, false, target.attemptId);
  assert.equal(restored.contentVersion, '1.0.0'); assert.deepEqual(restored.answers, draft);
  const db = f.progress.openProgressDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reading_answers').get().n, 0);
  assert.equal(f.rewards.getRewards().readingTotal, 0);
  const other = f.reading.getReadingUnit(old.id, true); f.reading.saveReadingDraft(other.attemptId, draft);
  assert.throws(() => f.location(old.id, { questionId: 'old-harbor' }), /唯一恢复/);
});

test('versioned reading sources: a pinned old group maps to one historical child despite reordered new groups and an existing new draft', async t => {
  const f = await setup(t), data = structuredClone(f.data), groupId = 'history-group';
  const a = passage('history-a', [1], [question('group-harbor', 'harbor', 1)]);
  const b = passage('history-b', [2, 3], [question('group-sword', 'sword', 2), question('group-cat', 'cat', 3)]);
  data.units = [a, b].map(definition => ({ kind: 'passage', definition, composition: 'split', legacyGroupId: groupId }));
  data.legacyGroups = [{ id: groupId, title: 'Historical group', level: 'entry', background: '历史组卷', estimatedMinutes: 5,
    passages: [{ unitId: a.id }, { unitId: b.id }] }];
  await f.install(data);
  f.reading.getReadingUnit(b.id); // An existing independent round makes default migration preserve that round.
  f.reading.ensureReadingSchema(); const db = f.progress.openProgressDb(), parentId = 'old-group-attempt';
  const group = f.context.load('reading-bank').LEGACY_READING_BANK[0], now = new Date().toISOString();
  const answerMap = f.answers(group), earned = group.questions.flatMap(q => f.rewards.grantReadingReward(group, q, now, parentId));
  const result = { attemptId: parentId, answers: answerMap, score: 3, maxScore: 3, correct: 3, total: 3, earned, earnedCount: earned.length,
    questionResults: Object.fromEntries(group.questions.map(q => [q.id, { questionId: q.id, correct: true, firstCorrect: true, attempts: 1,
      earned: [], total: 3, rewarded: true, duplicate: false, assisted: false, hintUsed: false }])),
    rewardAnimationPending: false, duplicate: false, submittedAt: now, assisted: false };
  db.prepare('INSERT INTO reading_sessions(id,unit_id,created_at,paper_version,draft_json,paper_result_json,content_revision) VALUES(?,?,?,?,?,?,?)')
    .run(parentId, groupId, now, 2, JSON.stringify(answerMap), JSON.stringify(result), f.store.getReadingContentRevision(groupId));
  for (const q of group.questions) db.prepare('INSERT INTO reading_answers(attempt_id,question_id,first_answer,first_correct,last_answer,last_correct,attempts,last_assisted,hint_used,updated_at) VALUES(?,?,?,1,?,1,1,0,0,?)')
    .run(parentId, q.id, q.expected, q.expected, now);
  const next = structuredClone(data); next.manifest.version = '1.1.0'; next.legacyGroups[0].passages.reverse();
  next.units[1].definition = passage(b.id, [3], [question('group-cat', 'cat', 3)]);
  await f.install(next); const fresh = f.reading.getReadingUnit(b.id, true);
  const target = f.location(groupId, { paragraph: 2, questionId: 'group-sword', attemptId: parentId });
  assert.deepEqual(target, { unitId: b.id, paragraph: 1, questionId: 'group-sword', attemptId: parentId });
  const old = f.reading.getReadingUnit(target.unitId, false, target.attemptId);
  assert.equal(old.id, b.id); assert.equal(old.passageCount, 1); assert.equal(old.contentVersion, '1.0.0');
  assert.equal(old.paragraphs[0], english[1]); assert.deepEqual(old.questions.map(q => q.id), ['group-sword', 'group-cat']);
  assert.equal(old.paperResult.score, 2); assert.deepEqual(old.paperResult.earned, []); assert.equal(old.rewardAnimationPending, false);
  assert.equal(f.reading.getReadingUnit(b.id).attemptId, fresh.attemptId);
  assert.equal(f.reading.getReadingUnit(b.id, false, parentId).attemptId, old.attemptId);
  assert.equal(f.reading.getReadingUnit(groupId, false, parentId).passageCount, 1);
  assert.equal(f.rewards.getRewards().readingTotal, 3);
  assert.throws(() => f.location(a.id, { attemptId: old.attemptId }), /不匹配/);
});
