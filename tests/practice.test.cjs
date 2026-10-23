const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/practice-fixture.cjs');

test('source priority: reading, indexed dialogue, then dictionary; no substring matches', t => {
  const f = fixture(t);
  for (const [id, kind, expected] of [[1,'reading','harbor'],[3,'dialogue','sword'],[4,'spelling','oxygen'],[6,'spelling','art'],[15,'spelling','cat']]) {
    const payload = f.exercise.createExerciseForWord('test', f.content.getWord(id));
    assert.equal(payload.exercise.kind, kind);
    assert.equal(payload.solutions[0].expected, expected);
    assert.equal(payload.exercise.blanks[0].wordId, id);
    assert.equal(payload.exercise.parts.filter(p => 'blankId' in p).length, id === 3 ? 2 : 1);
    assert.ok(payload.solutions[0].accepted.includes(expected));
    assert.ok(!('solutions' in payload.exercise));
    assert.ok(!('accepted' in payload.exercise.blanks[0]));
    assert.ok(!('expected' in payload.exercise.blanks[0]));
  }
  assert.equal(f.exercise.createExerciseForWord('test', f.content.getWord(3)).exercise.speaker, '派蒙');
});

test('Unicode, phrases and inflections preserve exact source offsets and word IDs', t => {
  const f = fixture(t);
  for (const [id, expected] of [[7,'analyzed'],[8,'analyses'],[9,'café'],[12,'ice cream'],[13,'running'],[14,'travelers'],[17,'colors']]) {
    const { exercise, solutions } = f.exercise.createExerciseForWord('test', f.content.getWord(id));
    assert.equal(exercise.kind, 'reading');
    assert.equal(solutions[0].expected, expected);
    const restored = exercise.parts.map(p => p.text ?? solutions[0].expected).join('');
    const source = f.context.load('practice-content').findPracticeSource(f.content.getWord(id));
    assert.equal(restored, source.text);
    assert.equal(source.text.slice(source.start, source.end), expected);
  }
});

test('UK/US variants preserve original grammar in collection tests and lemma spelling in self-tests', t => {
  const f = fixture(t), scope = '__collection__';
  f.collect(6,'analyzed'); f.review(7,3,scope);
  assert.equal(f.answer(f.exercise.buildExercise(scope,7),'  ANALYSED  ').answers[0].correct,true);
  assert.equal(f.answer(f.exercise.buildExercise(scope,7),'analyse').answers[0].correct,false);
  assert.equal(f.answer(f.exercise.buildExercise(scope,7),'analyzd').answers[0].correct,false);
  f.review(7);
  assert.equal(f.answer(f.exercise.buildExercise('test',7,'spelling'),'ANALYZE').answers[0].correct,true);
  assert.equal(f.answer(f.exercise.buildExercise('test',7,'spelling'),'analysed').answers[0].correct,false);
  f.review(8);
  assert.equal(f.answer(f.exercise.buildExercise('test',8,'spelling'),'analyzes').answers[0].correct,false);
  f.review(1);
  assert.equal(f.answer(f.exercise.buildExercise('test',1,'spelling'),'HARBOR').answers[0].correct,true);
  f.review(9);
  assert.equal(f.answer(f.exercise.buildExercise('test',9,'spelling'),'cafe\u0301').answers[0].correct,true);
});

test('missing meaning uses audio; missing all hints still produces a solvable letter exercise', t => {
  const f = fixture(t);
  const audio = f.exercise.createExerciseForWord('test', f.content.getWord(11));
  assert.equal(audio.exercise.title, '听音拼写');
  assert.equal(audio.exercise.letterBank, undefined);
  const letters = f.exercise.createExerciseForWord('test', f.content.getWord(10));
  assert.equal(letters.exercise.title, '字母重排');
  assert.equal(letters.exercise.letterBank.replaceAll(' ','').split('').sort().join(''), 'zyxword'.split('').sort().join(''));
  f.review(10);
  const result = f.answer(f.exercise.buildExercise('test',10),'zyxword');
  assert.equal(result.earned.length,1);
});

test('every reviewed word rotates, including repeated skips, and rotation survives reopening', t => {
  const f = fixture(t);
  const ids = [1,3,4,7];
  ids.forEach(id => f.review(id));
  const seen = new Set();
  for (let i=0; i<ids.length; i++) {
    if (i===2) f.progress.closeProgressDb();
    const question = f.exercise.buildExercise('test');
    assert.ok(!seen.has(question.blanks[0].wordId));
    seen.add(question.blanks[0].wordId);
  }
  assert.deepEqual(seen,new Set(ids));
  const next = f.exercise.buildExercise('test');
  assert.ok(seen.has(next.blanks[0].wordId));
  const rows = f.progress.openProgressDb().prepare("SELECT shown_count FROM practice_progress WHERE book_id='test'").all();
  assert.equal(rows.reduce((n,r)=>n+r.shown_count,0),5);
});

test('collection words have independent sessions, stats and rewards', t => {
  const f = fixture(t);
  const collections = f.context.load('collections');
  const scope = '__collection__';
  const base = f.study.getStats('test').total;
  const added = f.collect(5, 'Extra');
  assert.equal(added.word.id, 5);
  assert.deepEqual(f.study.buildSession(scope,100,100),[5]);
  assert.ok(!f.study.buildSession('test',100,100).includes(5));
  assert.equal(f.study.getStats('test').total,base);
  assert.equal(f.rewards.getRewards().total,0);
  assert.equal(f.study.getStats(scope).total,1);
  assert.throws(()=>f.review(5),/学习列表/);
  f.review(5,3,scope);
  const question = f.exercise.buildExercise(scope,5);
  assert.equal(question.kind,'collection');
  assert.equal(f.answer(question,'extra').earned[0].wordId,5);
  assert.equal(f.rewards.getRewards().total,1);
  assert.equal(f.rewards.getRewards().history.filter(entry => entry.source === 'word' && entry.bookId === 'test').length,0);
  assert.equal(collections.listCollection().length,1);
});

test('unreviewed, invalid and out-of-list targets cannot earn rewards', t => {
  const f = fixture(t);
  assert.equal(f.exercise.buildExercise('test'),null);
  assert.equal(f.exercise.buildExercise('missing'),null);
  assert.throws(()=>f.exercise.buildExercise('test',1),/先/);
  assert.throws(()=>f.exercise.buildExercise('test',NaN),/先/);
  assert.throws(()=>f.review(16),/学习列表/);
  f.review(1);
  assert.throws(()=>f.exercise.buildExercise('test',16),/先/);
  assert.equal(f.rewards.getRewards().total,0);
});

test('wrong answers do not grant rewards; repeated submissions and new correct attempts grant once', t => {
  const f = fixture(t);
  f.review(4);
  const wrong = f.exercise.buildExercise('test',4);
  assert.equal(f.answer(wrong,'wrong').earned.length,0);
  const immutable = f.answer(wrong,'oxygen');
  assert.equal(immutable.alreadySubmitted,true);
  assert.equal(immutable.answers[0].correct,false);
  const right = f.exercise.buildExercise('test',4);
  assert.equal(f.answer(right,'oxygen').earned.length,1);
  assert.equal(f.answer(right,'wrong').earned.length,0);
  assert.equal(f.answer(right,'wrong').answers[0].correct,true);
  assert.equal(f.answer(f.exercise.buildExercise('test',4),'oxygen').earned.length,0);
  assert.equal(f.rewards.getRewards().total,1);
  assert.equal(f.progress.openProgressDb().prepare('SELECT count(*) AS n FROM reward_ledger').get().n,1);
});

test('subjective ratings never grant gems; an objective pass earns independently of the earlier rating', t => {
  const f = fixture(t);
  assert.equal(f.review(4,1).earned.length,0);
  assert.equal(f.answer(f.exercise.buildExercise('test',4),'oxygen').earned.length,1);
  f.progress.openProgressDb().prepare("UPDATE review_logs SET reviewed_at='2000-01-01T00:00:00.000Z'").run();
  assert.equal(f.study.reviewCard(4,'test',3,'memory-again').earned.length,0);
  assert.equal(f.review(3).earned.length,0);
  assert.equal(f.answer(f.exercise.buildExercise('test',3),'sword').earned.length,1);
  assert.equal(f.rewards.getRewards().total,2);
  assert.equal(f.rewards.getRewards().wordTotal,2);
  assert.equal(f.rewards.getRewards().readingTotal,0);
});

test('v2 multi-blank spelling attempts grade legacy solution shape and preserve new rewards across reopening', t => {
  const f = fixture(t);
  f.review(1);
  const question = f.exercise.buildExercise('test',1,'spelling');
  const db = f.progress.openProgressDb();
  const row = db.prepare('SELECT payload_json FROM exercise_attempts WHERE id=?').get(question.id);
  const payload = JSON.parse(row.payload_json);
  delete payload.solutions[0].accepted;
  payload.solutions.push({...payload.solutions[0],id:'blank-2'});
  db.prepare('UPDATE exercise_attempts SET payload_json=? WHERE id=?').run(JSON.stringify(payload),question.id);
  const result = f.exercise.submitExercise(question.id,{'answer':'harbour','blank-2':'harbor'});
  assert.equal(result.earned.length,1);
  const mastered = f.rewards.getRewards().history[0].earnedAt;
  db.exec('DROP TABLE practice_progress');
  f.progress.closeProgressDb();
  assert.equal(f.rewards.getRewards().history[0].earnedAt,mastered);
  assert.ok(f.progress.getCard(1,'test').reps>0);
  assert.equal(f.exercise.submitExercise(question.id,{}).alreadySubmitted,true);
  assert.equal(f.exercise.buildExercise('test',1).blanks[0].wordId,1);
});

test('expired attempts fail without changing progress and stale unanswered attempts are pruned', t => {
  const f = fixture(t);
  f.review(4);
  const question = f.exercise.buildExercise('test',4);
  f.progress.openProgressDb().prepare("UPDATE exercise_attempts SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(question.id);
  assert.throws(()=>f.answer(question,'oxygen'),/过期/);
  assert.equal(f.rewards.getRewards().total,0);
  f.exercise.buildExercise('test',4);
  assert.equal(f.progress.openProgressDb().prepare('SELECT id FROM exercise_attempts WHERE id=?').get(question.id),undefined);
});

test('book progress stays separate and content database stays read-only', t => {
  const f = fixture(t);
  f.review(4);
  f.answer(f.exercise.buildExercise('test',4),'oxygen');
  assert.equal(f.exercise.buildExercise('other'),null);
  assert.equal(f.rewards.getRewards().history.filter(entry => entry.source === 'word' && entry.bookId === 'other').length,0);
  f.review(4,3,'other');
  assert.equal(f.answer(f.exercise.buildExercise('other',4),'oxygen').earned.length,1);
  assert.equal(f.rewards.getRewards().total,2);
  assert.throws(()=>f.content.openContentDb().prepare("UPDATE words SET lemma='changed' WHERE id=4").run(),/readonly/i);
});

test('collection original-sentence tests hide every occurrence and require every blank correct', t => {
  const f = fixture(t), scope='__collection__';
  f.content.closeContentDb();
  const Database=require('better-sqlite3'), writable=new Database(f.contentPath);
  writable.prepare("INSERT INTO dialog_lines(id,quest_id,speaker,text_en,text_chs) VALUES(8,1,'Paimon','Your sword is a sword.','')").run();
  writable.close();
  // Reopen through the production read-only content accessor.
  f.content.closeContentDb();
  f.collect(8,'sword'); f.review(3,3,scope);
  const question=f.exercise.buildExercise(scope,3);
  assert.equal(question.blanks.length,2);
  assert.ok(!question.parts.some(part => part.text?.includes('sword')));
  assert.equal(f.exercise.submitExercise(question.id,{'blank-1':'sword','blank-2':'swords'}).earned.length,0);
  assert.equal(f.answer(f.exercise.buildExercise(scope,3),'sword').earned.length,1);
});

test('collection tests use only the clicked sentence even when other reading material exists', t => {
  const f = fixture(t);
  const scope = '__collection__';
  const result = f.collect(1,'sword',1);
  assert.equal(result.word.id,3);
  const collection = f.context.load('collections');
  const source = collection.getCollectedSource(3);
  assert.equal(source.text,'Another sword is here.');
  assert.equal(source.lineId,1);
  assert.equal(source.text.slice(source.start,source.end),'sword');
  assert.equal(collection.getCollectionReview(3)[0].text_en,'Another sword is here.');
  f.review(3,3,scope);
  for (let i=0;i<3;i++) {
    const question = f.exercise.buildExercise(scope,3);
    assert.equal(question.kind,'collection');
    assert.equal(question.blanks.length,1);
    const restored = question.parts.map(part=>part.text ?? 'sword').join('');
    assert.equal(restored,'Another sword is here.');
    assert.equal(f.answer(question,'sword').earned.length,i===0?1:0);
  }
  const book = f.exercise.createExerciseForWord('test',f.content.getWord(3));
  assert.equal(book.exercise.kind,'dialogue');
  assert.equal(book.exercise.blanks.length,2);
});

test('duplicate capture, removal and restoration preserve first source and do not duplicate rewards', t => {
  const f = fixture(t), scope='__collection__', collection=f.context.load('collections');
  f.collect(1,'sword',1);
  const original=collection.getCollectedSource(3);
  assert.equal(f.collect(1,'sword',0).status,'existing');
  assert.deepEqual(collection.getCollectedSource(3),original);
  f.review(3,3,scope);
  f.answer(f.exercise.buildExercise(scope,3),'sword');
  assert.equal(collection.removeCollectedWord(3),true);
  assert.equal(f.study.getStats(scope).total,0);
  assert.equal(f.exercise.buildExercise(scope),null);
  assert.throws(()=>f.review(3,3,scope),/学习列表/);
  assert.equal(collection.restoreCollectedWord(3),true);
  assert.deepEqual(collection.getCollectedSource(3),original);
  assert.equal(f.rewards.getRewards().total,1);
  assert.equal(f.answer(f.exercise.buildExercise(scope,3),'sword').earned.length,0);
  collection.removeCollectedWord(3);
  assert.equal(f.collect(1,'sword',0).status,'restored');
  assert.deepEqual(collection.getCollectedSource(3),original);
});

test('local provenance validation rejects unknown words, forged IDs, partial tokens and supplied text', t => {
  const f=fixture(t), collection=f.context.load('collections');
  assert.throws(()=>collection.collectFromDialogue({lineId:9999,start:0,end:4}),/本地台词/);
  assert.throws(()=>collection.collectFromDialogue({lineId:1,start:2,end:4}),/完整单词/);
  assert.throws(()=>collection.collectFromDialogue({lineId:1,start:-1,end:4}),/完整单词/);
  assert.throws(()=>collection.collectFromDialogue({lineId:1,start:2,end:7.5}),/完整单词/);
  assert.throws(()=>f.collect(7,'unlistedword'),/未收录/);
  const result=collection.collectFromDialogue({lineId:1,start:2,end:7,text:'External forged text',wordId:5});
  assert.equal(result.word.id,3);
  assert.equal(collection.getCollectedSource(3).text,'A sword is ready. ');
  assert.equal(collection.listCollection().length,1);
});

test('Unicode, possessives, hyphens and UK/US variants are collected as complete local tokens', t => {
  const f=fixture(t), collection=f.context.load('collections'), scope='__collection__';
  const tokens=f.context.load('../shared/text').wordTokens('A café and a traveller’s eco-tourist friend.');
  assert.deepEqual(tokens.map(t=>t.text),['A','café','and','a','traveller’s','eco-tourist','friend']);
  for (const [surface,id] of [['café',9],['traveler’s',14],['eco-tourist',18],['analyzed',7]]) {
    assert.equal(f.collect(6,surface).word.id,id);
    const source=collection.getCollectedSource(id);
    assert.equal(source.text.slice(source.start,source.end),surface);
    f.review(id,3,scope);
    const question=f.exercise.buildExercise(scope,id);
    assert.equal(f.answer(question,surface).answers.every(a=>a.correct),true);
  }
  assert.equal(f.exercise.createExerciseForWord(scope,f.content.getWord(7)).solutions[0].accepted.includes('analysed'),true);
});

test('legacy bookmarks migrate once without inventing sources or losing learning history; old gems reset once', t => {
  const f=fixture(t), scope='__collection__';
  const db=f.progress.openProgressDb();
  db.prepare('INSERT INTO bookmarks VALUES(?,?,?)').run(5,'test','2020-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO bookmarks VALUES(?,?,?)').run(5,'other','2021-01-01T00:00:00.000Z');
  f.study.ensureCard(5,'test'); f.study.ensureCard(5,'other');
  db.prepare("UPDATE cards SET reps=3,last_review='2025-01-01T00:00:00.000Z' WHERE word_id=5 AND book_id='test'").run();
  db.prepare("UPDATE cards SET reps=4,last_review='2026-01-01T00:00:00.000Z' WHERE word_id=5 AND book_id='other'").run();
  f.progress.logReview(5,'other',3);
  db.prepare("INSERT INTO mastery VALUES(5,'other','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z')").run();
  db.prepare("INSERT INTO rewards VALUES(5,'other','extra','2026-01-02T00:00:00.000Z')").run();
  db.prepare("DELETE FROM schema_migrations WHERE version IN ('independent-collection-v1','independent-rewards-v2')").run();
  f.progress.closeProgressDb();
  const collection=f.context.load('collections');
  assert.equal(collection.listCollection().length,1);
  assert.equal(collection.getCollectedSource(5),null);
  assert.equal(f.progress.getCard(5,scope).reps,4);
  assert.equal(f.rewards.getRewards().total,0);
  assert.equal(f.study.getStats(scope).pendingSource,1);
  assert.equal(f.exercise.buildExercise(scope),null);
  assert.throws(()=>f.exercise.buildExercise(scope,5),/来源句/);
  assert.throws(()=>f.exercise.createExerciseForWord(scope,f.content.getWord(5)),/来源句/);
  assert.deepEqual(collection.getCollectionReview(5),[]);
  assert.equal(f.progress.openProgressDb().prepare('SELECT practice_correct_at FROM mastery WHERE word_id=5 AND book_id=?').get(scope).practice_correct_at,null);
  const count=f.progress.openProgressDb().prepare('SELECT count(*) AS n FROM review_logs').get().n;
  f.progress.closeProgressDb(); f.progress.openProgressDb();
  assert.equal(f.progress.openProgressDb().prepare('SELECT count(*) AS n FROM review_logs').get().n,count);
  assert.equal(f.progress.getCard(5,'other').reps,4);
  assert.equal(f.collect(5,'Extra').status,'source-added');
  assert.equal(f.study.getStats(scope).pendingSource,0);
  assert.equal(f.exercise.buildExercise(scope,5).kind,'collection');
  assert.equal(f.rewards.getRewards().total,0);
  assert.equal(f.answer(f.exercise.buildExercise(scope,5),'extra').earned.length,1);
  assert.equal(f.rewards.getRewards().total,1);
});

test('pending legacy sources cannot starve valid collection tests', t => {
  const f=fixture(t), scope='__collection__';
  f.progress.openProgressDb().prepare("INSERT INTO collected_words(word_id,created_at) VALUES(4,'2020-01-01T00:00:00.000Z')").run();
  f.collect(1,'sword');
  f.review(4,3,scope); f.review(3,3,scope);
  for(let i=0;i<3;i++) assert.equal(f.exercise.buildExercise(scope).blanks[0].wordId,3);
  assert.equal(f.study.getStats(scope).pendingSource,1);
  assert.equal(f.context.load('collections').getCollectionReview(4).length,0);
});

test('collection progress and sources survive restart; order is oldest first and books remain independent', t => {
  const f=fixture(t), scope='__collection__';
  f.collect(5,'Extra'); f.collect(1,'sword');
  f.progress.openProgressDb().prepare("UPDATE collected_words SET created_at='2000-01-01T00:00:00.000Z' WHERE word_id=5").run();
  assert.equal(f.study.buildSession(scope,1,0)[0],5);
  f.review(3,3,scope);
  assert.equal(f.progress.getCard(3,'test'),undefined);
  const source=f.context.load('collections').getCollectedSource(3);
  f.progress.closeProgressDb();
  assert.deepEqual(f.context.load('collections').getCollectedSource(3),source);
  assert.ok(f.progress.getCard(3,scope).reps>0);
  f.review(3,3,'test');
  assert.equal(f.exercise.buildExercise('test',3).kind,'recognition');
  assert.equal(f.exercise.buildExercise(scope,3).kind,'collection');
});

test('recognition self-test hides the answer, has distinct choices, and stores first result across corrections', t => {
  const f=fixture(t);
  f.review(4);
  const first=f.exercise.buildExercise('test',4);
  assert.equal(first.kind,'recognition');
  assert.equal(first.options.length,4);
  assert.equal(new Set(first.options.map(option=>option.text)).size,4);
  assert.equal(first.blanks[0].translation,'');
  assert.ok(!('solutions' in first));
  assert.ok(!('expected' in first.blanks[0]));
  const right=first.options.find(option=>option.text===f.content.getWord(4).translation);
  const wrong=first.options.find(option=>option.id!==right.id);
  const failed=f.exercise.submitExercise(first.id,{answer:wrong.id});
  assert.equal(failed.answers[0].correct,false);
  assert.equal(failed.firstCorrect,false);
  assert.equal(failed.earned.length,0);
  assert.ok(f.progress.getCard(4,'test').reps>=2);
  const second=f.exercise.buildExercise('test',4);
  const passed=f.answer(second,'oxygen');
  assert.equal(passed.answers[0].correct,true);
  assert.equal(passed.firstCorrect,false);
  assert.equal(passed.attempts,2);
  assert.equal(passed.earned.length,1);
  assert.equal(passed.earned[0].source,'word');
  assert.equal(passed.earned[0].bookName,'测试词书');
  f.progress.closeProgressDb();
  const row=f.progress.openProgressDb().prepare("SELECT first_correct,last_correct,attempts FROM word_self_tests WHERE word_id=4 AND book_id='test'").get();
  assert.deepEqual(row,{first_correct:0,last_correct:1,attempts:2});
});

test('reward migration resets legacy gems once, preserves learning and source, and rejects old pending exercises', t => {
  const f=fixture(t);
  f.collect(1,'sword');
  f.review(3); f.review(3,3,'__collection__');
  const source=f.context.load('collections').getCollectedSource(3);
  const db=f.progress.openProgressDb();
  const before=f.progress.getCard(3,'test');
  db.prepare("INSERT INTO rewards VALUES(3,'test','sword','2025-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO exercise_attempts(id,book_id,payload_json,created_at,reward_version) VALUES('old','test','{}',?,1)").run(new Date().toISOString());
  db.prepare("DELETE FROM schema_migrations WHERE version='independent-rewards-v2'").run();
  f.progress.closeProgressDb();
  assert.equal(f.rewards.getRewards().total,0);
  assert.equal(f.progress.openProgressDb().prepare('SELECT count(*) AS n FROM rewards').get().n,0);
  assert.deepEqual(f.progress.getCard(3,'test'),before);
  assert.deepEqual(f.context.load('collections').getCollectedSource(3),source);
  assert.throws(()=>f.exercise.submitExercise('old',{}),/旧版/);
  assert.equal(f.answer(f.exercise.buildExercise('test',3),'sword').earned.length,1);
  f.progress.closeProgressDb();
  assert.equal(f.rewards.getRewards().total,1);
  assert.equal(f.answer(f.exercise.buildExercise('test',3),'sword').earned.length,0);
});

test('single-word scopes fall back to spelling and invalid self-test modes fail', t => {
  const f=fixture(t);
  f.review(4,3,'other');
  const question=f.exercise.buildExercise('other',4);
  assert.equal(question.kind,'spelling');
  assert.equal(f.answer(question,'oxygen').earned.length,1);
  assert.throws(()=>f.exercise.buildExercise('other',4,'random'),/自测方式/);
});
