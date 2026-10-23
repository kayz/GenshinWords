const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/practice-fixture.cjs');

test('50 个公开方法与主进程通道一一对应，转发参数和返回值', async t => {
  const f = fixture(t);
  const { createApi, apiChannels } = f.context.load('../shared/ipc');
  const { handlers } = f.context.load('ipc');
  assert.equal(Object.keys(apiChannels).length, 50);
  assert.equal(new Set(Object.values(apiChannels)).size, 50);
  assert.deepEqual(Object.values(apiChannels).sort(), Object.keys(handlers).sort());
  const calls = [];
  const result = { marker: 'result' };
  const api = createApi(async (channel, ...args) => { calls.push({ channel, args }); return result; });
  assert.deepEqual(Object.keys(api).sort(), Object.keys(apiChannels).sort());
  for (const [method, channel] of Object.entries(apiChannels)) {
    const args = ['first', 2, { value: 'third' }];
    assert.equal(await api[method](...args), result);
    assert.deepEqual(calls.at(-1), { channel, args });
  }
});

test('共享桥接调用真实处理函数，读取词书、词卡和剧情并规范空结果', async t => {
  const f = fixture(t);
  const { createApi } = f.context.load('../shared/ipc');
  const { handlers } = f.context.load('ipc');
  const api = createApi(async (channel, ...args) => handlers[channel]({}, ...args));
  assert.equal(await api.contentAvailable(), true);
  const [book] = await api.listBooks();
  assert.equal(book.id, 'test');
  assert.equal(typeof book.word_count, 'number');
  assert.deepEqual(await api.listCoverage(), []);
  assert.equal((await api.getWord(3)).word.lemma, 'sword');
  assert.equal((await api.getWord(3)).examples[0].surface, 'sword');
  assert.equal(await api.getWord(999999), null);
  assert.equal(await api.lookupWord('unlistedword'), null);
  assert.equal((await api.lookupWord('sword')).id, 3);
  assert.equal((await api.getChapter(1)).id, 1);
  assert.equal(await api.getChapter(999999), null);
  assert.equal((await api.listVersions())[0].version, '1');
  assert.equal((await api.listSources())[0].type, 'aq');
  assert.equal((await api.listChapters('1', 'aq'))[0].id, 1);
  assert.equal((await api.listQuests(1))[0].chapter_id, 1);
  assert.equal((await api.listDialog(1))[0].quest_id, 1);
  assert.equal((await api.getPronunciation(11)).audio_uk, 'sound.mp3');
  await api.setSetting('studyOrder', 'invalid-old-value');
  assert.equal(await api.getSetting('studyOrder'), 'default');
  await api.setBrowseProgress('version', '1');
  assert.equal(await api.getBrowseProgress('version'), '1');
  for (const value of Object.values(await api.getStats('test'))) assert.equal(typeof value, 'number');
  assert.ok((await api.buildSession('test', 10, 40, 'default')).every(Number.isSafeInteger));
});

test('共享桥接保持独立收藏的原句、评分、测试和奖励结构', async t => {
  const f = fixture(t);
  const { createApi } = f.context.load('../shared/ipc');
  const { handlers } = f.context.load('ipc');
  const api = createApi(async (channel, ...args) => handlers[channel]({}, ...args));
  const scope = '__collection__';
  const added = await api.collectWord({ lineId: 5, start: 0, end: 5 });
  assert.equal(added.status, 'added');
  assert.equal(added.word.id, 5);
  assert.equal((await api.listCollection())[0].source.text, 'Extra matters here. ');
  assert.equal((await api.getWord(5, scope)).examples[0].text_en, 'Extra matters here. ');
  assert.deepEqual(await api.buildSession(scope), [5]);
  assert.equal(await api.buildExercise(scope), null);
  await assert.rejects(api.rateReview(5, scope, 'invalid'), /Invalid rating/);
  const reviewed = await api.rateReview(5, scope, 'good', 'ipc-review');
  assert.equal(typeof reviewed.due, 'string');
  assert.equal(typeof reviewed.state, 'number');
  assert.equal(reviewed.duplicate, false);
  const exercise = await api.buildExercise(scope, 5);
  assert.equal(exercise.kind, 'collection');
  const result = await api.submitExercise(exercise.id, Object.fromEntries(exercise.blanks.map(b => [b.id, 'extra'])));
  assert.ok(result.answers.every(a => a.correct));
  assert.equal(result.earned[0].wordId, 5);
  assert.equal((await api.getRewards()).total, 1);
  assert.equal((await api.rateReview(5, scope, 'good', 'ipc-review')).duplicate, true);
  assert.equal(await api.removeCollectedWord(5), true);
  assert.deepEqual(await api.listCollection(), []);
  assert.equal(await api.restoreCollectedWord(5), true);
  assert.equal((await api.listCollection()).length, 1);
});
