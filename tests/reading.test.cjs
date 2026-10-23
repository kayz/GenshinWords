const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/practice-fixture.cjs');

const { loadMain, root } = require('./helpers/load-main.cjs');
const sourceContext=loadMain(path.join(root,'content/content.db'));
let packageData,definitions;
try{const valid=sourceContext.load('reading-package-format').decodeReadingPackage(fs.readFileSync(path.join(root,'content/reading/base.gwreading')));packageData=valid.data;definitions=valid.units;}
finally{sourceContext.close();}
const MATERIAL_IDS=[...new Set(definitions.map(unit=>unit.materialId))];
// A separate legacy library fixture proves reading packages no longer depend on it.
const sourceSchema={materials:'CREATE TABLE materials(id TEXT PRIMARY KEY)',texts:'CREATE TABLE texts(material_id TEXT,locale TEXT,text TEXT,paragraphs_json TEXT)'};
const sourceRows={materials:packageData.sources.map(source=>({id:source.id})),texts:packageData.sources.flatMap(source=>['en','chs'].map(locale=>({material_id:source.id,locale,text:source[locale].text,paragraphs_json:JSON.stringify(source[locale].paragraphs.map((text,order)=>({order,text})))})))};

// 仅复制题库实际选用的英中文本，不复制整库或与测试无关的源图谱外键目标。
function readingFixture(t) {
  const f = fixture(t);
  const materialsPath = path.join(f.directory, 'materials.db');
  const db = new Database(materialsPath);
  try {
    db.pragma('foreign_keys = OFF');
    for (const table of ['materials', 'texts']) {
      db.exec(sourceSchema[table]);
      const columns = Object.keys(sourceRows[table][0]);
      const quoted = columns.map(column => '"' + column + '"').join(',');
      const insert = db.prepare('INSERT INTO ' + table + '(' + quoted + ') VALUES(' + columns.map(() => '?').join(',') + ')');
      for (const row of sourceRows[table]) insert.run(columns.map(column => row[column]));
    }
  } finally { db.close(); }
  const reading = f.context.load('reading');
  const bank = f.context.load('reading-bank').READING_BANK;
  const collection = f.context.load('collections');
  const readingCollection = f.context.load('reading-collection');
  let serial = 0;
  function open(index = 0, startNew = false) { return reading.getReadingUnit(bank[index].id, startNew); }
  function answers(unit, wrongIndices = []) {
    return Object.fromEntries(bank.find(item => item.id === unit.id).questions.map((question, index) => [
      question.id, wrongIndices.includes(index)
        ? question.type === 'fill' ? 'incorrectword' : question.options.find(option => option.id !== question.expected).id
        : question.expected,
    ]));
  }
  function submit(unit, answerMap = answers(unit), requestId = 'paper-request-' + (++serial)) {
    return reading.submitReadingPaper(unit.attemptId, answerMap, requestId);
  }
  return { ...f, reading, bank, materialsPath, open, answers, submit, collection, readingCollection };
}
function count(db, table) { return db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n; }
function assertNoSolutions(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['expected', 'accepted', 'solution', 'answerId', 'explanation', 'optionExplanations'].includes(key), '公开题面泄漏字段：' + key);
    assertNoSolutions(child);
  }
}

test('reading paper: five verified local units retain 25 stable questions and varied formats', t => {
  const f = readingFixture(t);
  const basicIds = new Set(f.bank.filter(unit => !unit.paper).map(unit => unit.id));
  const units = f.reading.listReadingUnits().filter(unit => basicIds.has(unit.id));
  assert.deepEqual(units.map(unit => unit.level), ['entry', 'sh_zhongkao', 'sh_gaokao', 'cet4', 'cet6']);
  assert.deepEqual(units.map(unit => unit.wordCount), [38, 172, 351, 355, 550]);
  assert.equal(units.reduce((n, unit) => n + unit.questionCount, 0), 25);
  const ids = f.bank.filter(unit=>!unit.paper).flatMap(unit => unit.questions.map(question => question.id));
  assert.equal(new Set(ids).size, 25);
  assert.equal(f.reading.submitReadingAnswer, undefined);
  assert.equal(f.reading.listReadingUnits('sh_zhongkao').length, f.bank.filter(unit=>unit.level==='sh_zhongkao').length);
  assert.throws(() => f.reading.listReadingUnits('unknown'), /级别/);
});

test('reading paper: unsubmitted public questions and saved drafts do not expose scores or answers', t => {
  const f = readingFixture(t); const unit = f.open();
  assertNoSolutions(unit.questions);
  assert.deepEqual(unit.answerResults, {});
  assert.equal(unit.paperResult, null);
  assert.equal(unit.rewardAnimationPending, false);
  const draft = { [unit.questions[0].id]: f.answers(unit)[unit.questions[0].id] };
  assert.equal(f.reading.saveReadingDraft(unit.attemptId, draft), true);
  assert.equal(count(f.progress.openProgressDb(), 'reading_answers'), 0);
  assert.equal(f.rewards.getRewards().total, 0);
  const restored = f.reading.getReadingUnit(unit.id);
  assert.deepEqual(restored.answers, draft);
  assert.deepEqual(restored.answerResults, {});
  assert.equal(restored.paperResult, null);
});

test('reading paper: drafts restore after reopening and cannot open analysis or grant gems', t => {
  const f = readingFixture(t); const unit = f.open();
  const draft = { [unit.questions[0].id]: 'A', [unit.questions[2].id]: '  TrA' };
  f.reading.saveReadingDraft(unit.attemptId, draft);
  f.progress.closeProgressDb();
  const reopened = f.reading.getReadingUnit(unit.id);
  assert.equal(reopened.attemptId, unit.attemptId);
  assert.deepEqual(reopened.answers, draft);
  assert.equal(f.rewards.getRewards().total, 0);
  assert.throws(() => f.reading.getReadingAnalysis(unit.attemptId), /交卷/);
  f.reading.saveReadingDraft(unit.attemptId, f.answers(unit));
  assert.throws(() => f.reading.getReadingAnalysis(unit.attemptId), /交卷/);
});

test('reading paper: validates every answer and rejects foreign question IDs without partial grading', t => {
  const f = readingFixture(t); const unit = f.open();
  const full = f.answers(unit);
  const missing = { ...full }; delete missing[unit.questions[0].id];
  assert.throws(() => f.submit(unit, missing), /全部题目/);
  assert.throws(() => f.submit(unit, { ...full, [unit.questions[0].id]: '' }), /全部题目/);
  assert.throws(() => f.submit(unit, { ...full, foreign: 'A' }), /不属于/);
  assert.throws(() => f.submit(unit, { ...full, [unit.questions[0].id]: 'Z' }), /选项/);
  assert.throws(() => f.submit(unit, { ...full, [unit.questions[0].id]: 1 }), /格式/);
  assert.throws(() => f.submit(unit, []), /格式/);
  assert.throws(() => f.submit(unit, full, ''), /编号/);
  assert.throws(() => f.reading.saveReadingDraft(unit.attemptId, { foreign: 'A' }), /不属于/);
  assert.equal(count(f.progress.openProgressDb(), 'reading_answers'), 0);
  assert.equal(count(f.progress.openProgressDb(), 'reading_paper_requests'), 0);
  assert.equal(f.rewards.getRewards().total, 0);
});

test('reading paper: one submission grades all questions and awards all newly correct items together', t => {
  const f = readingFixture(t); const unit = f.open(1);
  const result = f.submit(unit, f.answers(unit, [1]));
  assert.equal(result.score, 4); assert.equal(result.maxScore, 5);
  assert.equal(result.correct, 4); assert.equal(result.total, 5);
  assert.equal(result.earned.length, 4); assert.equal(result.earnedCount, 4);
  assert.equal(result.rewardAnimationPending, true);
  assert.equal(Object.keys(result.questionResults).length, 5);
  assert.equal(Object.values(result.questionResults).filter(row => row.correct).length, 4);
  assert.ok(Object.values(result.questionResults).every(row => row.earned.length === 0));
  assert.equal(count(f.progress.openProgressDb(), 'reading_answers'), 5);
  assert.equal(f.rewards.getRewards().readingTotal, 4);
  assert.equal(f.reading.getReadingAnalysis(unit.attemptId).questions.length, 5);
});

test('reading paper: reward failure rolls back the entire answer sheet, score and request atomically', t => {
  const f = readingFixture(t); const unit = f.open();
  const draft = { [unit.questions[0].id]: 'A' };
  f.reading.saveReadingDraft(unit.attemptId, draft);
  const db = f.progress.openProgressDb();
  const blocked = unit.questions[1].id.replaceAll("'", "''");
  db.exec("CREATE TRIGGER fail_paper_reward BEFORE INSERT ON reward_ledger WHEN NEW.item_id='" + blocked +
    "' BEGIN SELECT RAISE(ABORT,'fixture reward failure'); END;");
  assert.throws(() => f.submit(unit, f.answers(unit), 'atomic'), /fixture reward failure/);
  assert.equal(count(db, 'reading_answers'), 0);
  assert.equal(count(db, 'reading_paper_requests'), 0);
  assert.equal(count(db, 'reward_ledger'), 0);
  const restored = f.reading.getReadingUnit(unit.id);
  assert.equal(restored.paperResult, null);
  assert.deepEqual(restored.answers, draft);
  db.exec('DROP TRIGGER fail_paper_reward');
  assert.equal(f.submit(unit, f.answers(unit), 'atomic').earnedCount, 3);
});

test('reading paper: full canonical answer sheet and round are bound to request ID', t => {
  const f = readingFixture(t); const unit = f.open();
  const full = f.answers(unit);
  f.submit(unit, full, 'bound-sheet');
  const reversed = Object.fromEntries(Object.entries(full).reverse().map(([id, value]) => [id, '  ' + value.toLowerCase() + '  ']));
  const duplicate = f.submit(unit, reversed, 'bound-sheet');
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.earned, []);
  assert.equal(duplicate.earnedCount, 3);
  assert.throws(() => f.submit(unit, f.answers(unit, [0]), 'bound-sheet'), /编号已用于/);
  const other = f.open(1);
  assert.throws(() => f.submit(other, f.answers(other), 'bound-sheet'), /编号已用于/);
  assert.equal(f.rewards.getRewards().total, 3);
});

test('reading paper: submitted sheets are immutable, including delayed draft saves', t => {
  const f = readingFixture(t); const unit = f.open();
  const full = f.answers(unit, [0]);
  f.submit(unit, full, 'locked-first');
  assert.throws(() => f.submit(unit, f.answers(unit), 'locked-change'), /已交卷/);
  assert.equal(f.reading.saveReadingDraft(unit.attemptId, f.answers(unit)), false);
  const duplicate = f.submit(unit, full, 'locked-retry');
  assert.equal(duplicate.score, 2); assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.earned, []);
  const restored = f.reading.getReadingUnit(unit.id);
  assert.deepEqual(restored.answers, full);
  assert.equal(restored.paperResult.score, 2);
  assert.deepEqual(restored.paperResult.earned, []);
  assert.equal(f.rewards.getRewards().total, 2);
});

test('reading paper: reward animation acknowledgement survives restart and never grants rewards', t => {
  const f = readingFixture(t); const unit = f.open();
  assert.equal(f.reading.acknowledgeReadingReward(unit.attemptId), false);
  f.submit(unit);
  f.progress.closeProgressDb();
  let restored = f.reading.getReadingUnit(unit.id);
  assert.equal(restored.rewardAnimationPending, true);
  assert.equal(restored.paperResult.earnedCount, 3);
  assert.deepEqual(restored.paperResult.earned, []);
  assert.equal(f.reading.acknowledgeReadingReward(unit.attemptId), true);
  assert.equal(f.reading.acknowledgeReadingReward(unit.attemptId), false);
  f.progress.closeProgressDb();
  restored = f.reading.getReadingUnit(unit.id);
  assert.equal(restored.rewardAnimationPending, false);
  assert.equal(restored.paperResult.rewardAnimationPending, false);
  assert.equal(f.submit(unit).rewardAnimationPending, false);
  assert.equal(f.rewards.getRewards().total, 3);
});

test('reading paper: a later round can earn previously missed items once without changing historical first answers', t => {
  const f = readingFixture(t); const first = f.open();
  assert.equal(f.submit(first, f.answers(first, [0, 1])).score, 1);
  f.reading.getReadingAnalysis(first.attemptId);
  const next = f.open(0, true);
  const result = f.submit(next);
  assert.equal(result.score, 3); assert.equal(result.earnedCount, 2);
  assert.equal(f.rewards.getRewards().total, 3);
  assert.equal(f.reading.listReadingUnits()[0].firstCorrect, 1);
  const repeated = f.open(0, true);
  const repeatResult = f.submit(repeated);
  assert.equal(repeatResult.score, 3); assert.equal(repeatResult.earnedCount, 0);
  assert.equal(repeatResult.rewardAnimationPending, false);
  assert.equal(f.reading.acknowledgeReadingReward(repeated.attemptId), false);
  assert.equal(f.rewards.getRewards().total, 3);
  assert.throws(() => f.reading.saveReadingDraft(first.attemptId, {}), /已结束/);
});

test('reading paper: migration retains old per-question sessions and ledger while opening a new paper-version round', t => {
  const f = readingFixture(t);
  const db = f.progress.openProgressDb();
  db.exec(
    'CREATE TABLE reading_sessions(id TEXT PRIMARY KEY,unit_id TEXT NOT NULL,created_at TEXT NOT NULL,answers_viewed_at TEXT);' +
    'CREATE TABLE reading_answers(attempt_id TEXT NOT NULL,question_id TEXT NOT NULL,first_answer TEXT NOT NULL,first_correct INTEGER NOT NULL,' +
    'last_answer TEXT NOT NULL,last_correct INTEGER NOT NULL,attempts INTEGER NOT NULL,last_assisted INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(attempt_id,question_id));',
  );
  db.prepare('INSERT INTO reading_sessions(id,unit_id,created_at,answers_viewed_at) VALUES(?,?,?,NULL)').run('legacy-round', f.bank[0].id, '2020-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO reading_answers VALUES(?,?,?,?,?,?,1,0,?)')
    .run('legacy-round', f.bank[0].questions[0].id, 'B', 1, 'B', 1, '2020-01-01T00:00:00.000Z');
  f.rewards.grantReadingReward(f.bank[0], f.bank[0].questions[0]);
  const current = f.open();
  assert.notEqual(current.attemptId, 'legacy-round');
  assert.equal(db.prepare('SELECT paper_version FROM reading_sessions WHERE id=?').get('legacy-round').paper_version, 1);
  assert.equal(count(db, 'reading_answers'), 1);
  assert.equal(f.rewards.getRewards().total, 1);
  assert.equal(f.submit(current).earnedCount, 2);
  assert.equal(f.rewards.getRewards().total, 3);
  assert.equal(f.reading.getReadingAttemptResults('legacy-round').length, 1);
});

test('reading paper: PDF document is pure; successful early exposure permits scoring but prevents new awards', t => {
  const f = readingFixture(t);
  const clean = f.reading.getReadingDocument(f.bank[0].id);
  assert.ok(clean.analysis.questions[0].answer);
  assert.equal(count(f.progress.openProgressDb(), 'reading_sessions'), 0);
  const unit = f.open();
  const before = f.reading.getReadingDocument(unit.id, unit.attemptId);
  assert.equal(before.unit.paperResult, null); assert.equal(before.unit.answersViewed, false);
  f.reading.markReadingAnswersViewed(unit.attemptId, unit.id);
  assert.ok(f.reading.getReadingAnalysis(unit.attemptId).bilingualParagraphs.length);
  const result = f.submit(unit);
  assert.equal(result.score, 3); assert.equal(result.assisted, true);
  assert.equal(result.earnedCount, 0); assert.equal(result.rewardAnimationPending, false);
  assert.ok(Object.values(result.questionResults).every(row => !row.firstCorrect && row.correct && row.assisted));
  const after = f.reading.getReadingDocument(unit.id, unit.attemptId);
  assert.equal(after.unit.paperResult.score, 3);
  assert.equal(f.rewards.getRewards().total, 0);
});

test('reading paper: official bilingual source pairs and evidence retain verified paragraph numbering', t => {
  const f = readingFixture(t);
  const sizes = [1, 9, 10, 12, 7];
  for (const [index, definition] of f.bank.filter(unit=>!unit.paper).entries()) {
    assert.equal(definition.bilingualAlignmentVerified, true);
    assert.match(definition.chsTextSha256, /^[a-f0-9]{64}$/);
    const document = f.reading.getReadingDocument(definition.id);
    assert.equal(document.analysis.bilingualParagraphs.length, sizes[index]);
    for (const pair of document.analysis.bilingualParagraphs) {
      const original = sourceRows.texts.find(row => row.material_id === definition.materialId && row.locale === 'chs');
      assert.equal(pair.textEn, document.unit.paragraphs[pair.paragraph - 1]);
      assert.equal(pair.textChs, JSON.parse(original.paragraphs_json)[pair.paragraph - 1].text);
    }
    for (const sentence of document.analysis.sentences)
      assert.ok(document.unit.paragraphs[sentence.paragraph - 1].includes(sentence.text));
    for (const question of document.analysis.questions)
      assert.ok(question.evidence.every(number => number >= 1 && number <= sizes[index]));
  }
});

for (const locale of ['en', 'chs']) test('reading package: external '+locale+' library changes cannot replace its verified source',t=>{
  const f=readingFixture(t),unit=f.open(),before=f.reading.getReadingDocument(unit.id,unit.attemptId);
  const db=new Database(f.materialsPath);try{db.prepare('UPDATE texts SET text=text || ? WHERE material_id=? AND locale=?').run(' Changed.',MATERIAL_IDS[0],locale);}finally{db.close();}
  assert.deepEqual(f.reading.getReadingDocument(unit.id,unit.attemptId),before);
});

test('reading package: external bilingual order cannot alter packaged official pairs',t=>{
  const f=readingFixture(t),unit=f.open(1),before=f.reading.getReadingDocument(unit.id,unit.attemptId);
  const db=new Database(f.materialsPath);try{const row=db.prepare('SELECT paragraphs_json FROM texts WHERE material_id=? AND locale=?').get(MATERIAL_IDS[1],'chs');const parts=JSON.parse(row.paragraphs_json);parts[0].order=8;db.prepare('UPDATE texts SET paragraphs_json=? WHERE material_id=? AND locale=?').run(JSON.stringify(parts),MATERIAL_IDS[1],'chs');}finally{db.close();}
  assert.deepEqual(f.reading.getReadingDocument(unit.id,unit.attemptId),before);
});

test('reading paper: main-idea target glosses stay in analysis rather than pre-answer notes', t => {
  const f = readingFixture(t); const unit = f.open(1);
  const document = f.reading.getReadingDocument(unit.id);
  for (const term of ['conscientious', 'to the letter']) {
    assert.ok(!unit.glossary.some(gloss => gloss.term === term));
    assert.ok(document.analysis.glossary.some(gloss => gloss.term === term));
  }
});

test('independent reading: 21 practices retain official rows, masks, shared pools and 127 questions', t => {
  const f = readingFixture(t);
  const legacyPassages=new Set(f.context.load('reading-bank').LEGACY_READING_BANK.flatMap(group=>group.paper.passages.map(passage=>passage.id)));
  const papers=f.bank.filter(unit=>unit.paper&&legacyPassages.has(unit.id));
  assert.equal(papers.length,21);
  const byLevel={}; for(const practice of papers)byLevel[practice.level]=(byLevel[practice.level]||0)+practice.questions.length;
  assert.deepEqual(byLevel,{entry:12,sh_zhongkao:25,sh_gaokao:30,cet4:30,cet6:30});
  assert.equal(f.reading.listReadingUnits().length,f.bank.length);
  assert.ok(f.reading.listReadingUnits().every(unit=>unit.kind==='single'&&unit.passageCount===1&&unit.practiceType&&unit.estimatedMinutes>0));
  let total=0;
  const logicalSlots=new Map();
  for(const definition of papers){
    const unit=f.reading.getReadingUnit(definition.id),document=f.reading.getReadingDocument(unit.id);
    assert.equal(unit.kind,'single');assert.equal(unit.passageCount,1);
    assert.equal(definition.paper.passages.length,1);assert.equal(unit.practiceType,definition.paper.passages[0].type);
    assert.ok(unit.estimatedMinutes>0&&unit.wordCount>0);
    assert.equal(unit.sections.length,unit.passageCount);assertNoSolutions(unit.questions);assertNoSolutions(unit.sections.map(({glossary,...section})=>section));
    for(const sentence of document.analysis.sentences)
      assert.ok(document.analysis.bilingualParagraphs[sentence.paragraph-1].textEn.includes(sentence.text),'A key-sentence quotation is not present in its official source paragraph');
    assert.equal(unit.glossary.length,0,'Unsubmitted full papers must not expose a target-word glossary');
    let global=0;
    for(const passage of definition.paper.passages){
      for(const mask of passage.masks||[]){
        const key=[passage.materialId,mask.paragraph,mask.start,mask.end].join(':');
        if(logicalSlots.has(key))assert.equal(logicalSlots.get(key),mask.questionId,'The same source blank must retain its stable reward identity across papers');
        logicalSlots.set(key,mask.questionId);
      }
      const en=JSON.parse(sourceRows.texts.find(row=>row.material_id===passage.materialId&&row.locale==='en').paragraphs_json);
      const chs=JSON.parse(sourceRows.texts.find(row=>row.material_id===passage.materialId&&row.locale==='chs').paragraphs_json);
      for(const pair of passage.paragraphMap){
        const source=en[pair.en-1].text,translation=pair.chs.map(n=>chs[n-1].text).join('\n');
        assert.equal(document.analysis.bilingualParagraphs[global].textEn,source);
        assert.equal(document.analysis.bilingualParagraphs[global].textChs,translation);
        let masked=source;
        for(const mask of (passage.masks||[]).filter(m=>m.paragraph===pair.en).sort((a,b)=>b.start-a.start)){
          assert.equal(source.slice(mask.start,mask.end),mask.expectedText);
          const question=unit.questions.find(q=>q.id===mask.questionId),number=unit.questions.indexOf(question)+1;
          masked=masked.slice(0,mask.start)+'['+number+'] '+(question.firstLetter||'')+'________'+masked.slice(mask.end);
        }
        assert.equal(unit.paragraphs[global++],masked);
      }
      if(passage.optionPool)for(const question of unit.questions.filter(q=>q.passageId===passage.id&&q.type==='choice')){
        assert.equal(question.pooled,true);assert.deepEqual(question.options,passage.questions.find(q=>q.id===question.id).options||passage.optionPool);
      }
      const section=unit.sections.find(section=>section.id===passage.id),annotate=f.context.load('../shared/reading-text').annotateReadingParagraphs;
      const targets=[...(passage.masks||[]).map(mask=>mask.expectedText),...passage.questions.filter(q=>q.type==='fill').flatMap(q=>[q.expected,...(q.accepted||[])])];
      for(const entry of section.glossary||[]){
        assert.equal(entry.kind,'word');assert.equal(annotate(targets,[entry]).some(parts=>parts.some(part=>part.note)),false,'A blank target leaked through inline notes');
        assert.equal(annotate(section.paragraphIndices.map(n=>unit.paragraphs[n-1]),[entry]).some(parts=>parts.some(part=>part.note)),true);
      }
    }
    const results=f.submit(unit);total+=definition.questions.length;
    assert.equal(results.score,definition.questions.length);assert.equal(results.maxScore,definition.questions.length);
    assert.equal(results.earnedCount,definition.questions.length);assert.equal(results.rewardAnimationPending,true);
    assert.equal(f.reading.acknowledgeReadingReward(unit.attemptId),true);
    assert.equal(f.reading.getReadingUnit(unit.id).rewardAnimationPending,false);
  }
  assert.equal(total,127);assert.equal(f.rewards.getRewards().readingTotal,127);
});

test('reading packages: a stable question reused in another passage never earns a second gem',async t=>{
  const f=readingFixture(t),original=f.open();f.submit(original);
  const format=f.context.load('reading-package-format'),base=format.decodeReadingPackage(fs.readFileSync(path.join(root,'content/reading/base.gwreading'))).data;
  const entry=structuredClone(base.units.find(entry=>entry.definition.id===original.id));entry.definition.id='test-reused-paper';entry.definition.title='Same question in another passage';
  const reused=entry.definition,data={...base,manifest:{...base.manifest,id:'test.reused.questions',name:'共享题号测试包',version:'1.0.0'},units:[entry],legacyGroups:[],sources:base.sources.filter(source=>source.id===reused.materialId),images:base.images.filter(image=>image.path===reused.coverPath)};
  const file=path.join(f.directory,'shared.gwreading');fs.writeFileSync(file,format.encodeReadingPackage(data));const store=f.context.load('reading-package-store');await store.importReadingPackage((await store.previewReadingPackageFile(file)).token);
  const next=f.reading.getReadingUnit(reused.id),result=f.reading.submitReadingPaper(next.attemptId,Object.fromEntries(reused.questions.map(q=>[q.id,q.expected])),'cross-package-stable-id');
  assert.equal(result.score,reused.questions.length);assert.equal(result.earnedCount,0);assert.equal(f.rewards.getRewards().readingTotal,original.questions.length);
  assert.equal(f.reading.listReadingUnits().find(unit=>unit.id===reused.id).rewarded,original.questions.length);
});

test('reading packages: external paragraph tampering cannot override packaged source rows',t=>{
  const f=readingFixture(t),definition=f.bank.find(unit=>unit.paper),before=f.reading.getReadingDocument(definition.id);
  const passage=definition.paper.passages[0],db=new Database(f.materialsPath);
  try{const row=db.prepare("SELECT paragraphs_json FROM texts WHERE material_id=? AND locale='en'").get(passage.materialId);const parts=JSON.parse(row.paragraphs_json);parts[0].text+=' changed';db.prepare("UPDATE texts SET paragraphs_json=? WHERE material_id=? AND locale='en'").run(JSON.stringify(parts),passage.materialId);}finally{db.close();}
  assert.deepEqual(f.reading.getReadingDocument(definition.id),before);
});

test('reading papers: post-submission collection resolves each passage source and original unmasked text',t=>{
  const f=readingFixture(t),definition=f.bank.find(unit=>unit.paper),unit=f.reading.getReadingUnit(definition.id);f.submit(unit);
  const analysis=f.reading.getReadingAnalysis(unit.attemptId);
  for(const section of unit.sections){
    const number=section.paragraphIndices[0],source=f.reading.getReadingParagraphForCollection(unit.attemptId,number);
    assert.equal(source.textEn,analysis.bilingualParagraphs[number-1].textEn);assert.equal(source.sourceTitle,section.sourceTitle);
    assert.equal(source.sourceUrl,section.sourceUrl);assert.equal(source.coverPath,section.coverPath);assert.ok(source.title.includes(section.title));
  }
});

function addCollectionVocabulary(f) {
  const db = new Database(f.contentPath);
  try {
    const insert = db.prepare("INSERT INTO words(id,lemma,translation,phonetic,pos,phonetic_uk,phonetic_us) VALUES(?,?,?,'','','','')");
    insert.run(101, 'plate', '盘子'); insert.run(102, 'cabinet', '柜子');
    insert.run(103, 'wash', '洗'); insert.run(104, 'track', '记录');
    db.exec("INSERT INTO word_forms VALUES(101,'plates'),(103,'washed');");
    db.prepare("INSERT INTO dialog_lines(id,quest_id,speaker,text_en,text_chs,sort_order) VALUES(8,1,'Paimon',?,'盘子准备好了。',8)")
      .run('A plate is ready.');
  } finally { db.close(); }
}
function readingTokenRequest(f, unit, paragraph, surface, occurrence = 0) {
  const text = unit.paragraphs[paragraph - 1];
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(surface, start + 1);
  assert.ok(start >= 0);
  return { attemptId: unit.attemptId, paragraph, start, end: start + surface.length };
}

test('reading collection: only submitted or answer-exposed local original text may be collected', t => {
  const f = readingFixture(t); addCollectionVocabulary(f); const unit = f.open();
  const request = readingTokenRequest(f, unit, 1, 'washed');
  assert.throws(() => f.readingCollection.collectFromReading(request), /交卷进入解析/);
  f.reading.markReadingAnswersViewed(unit.attemptId, unit.id);
  assert.equal(f.readingCollection.collectFromReading(request).status, 'added');
  const other = f.open(1); f.submit(other);
  assert.equal(f.readingCollection.collectFromReading(readingTokenRequest(f, other, 5, 'plate')).status, 'added');
});

test('reading collection: keeps exact clicked sentence, inflected surface and sentence-relative UTF-16 offsets', t => {
  const f = readingFixture(t); addCollectionVocabulary(f); const unit = f.open(); f.submit(unit);
  const request = readingTokenRequest(f, unit, 1, 'washed');
  const result = f.readingCollection.collectFromReading(request);
  assert.equal(result.word.id, 103); assert.equal(result.word.lemma, 'wash');
  const source = f.collection.getCollectedSource(103);
  assert.equal(source.origin, 'reading'); assert.equal(source.unitId, unit.id); assert.equal(source.paragraph, 1);
  assert.equal(source.surface, 'washed');
  assert.equal(source.text.slice(source.start, source.end), 'washed');
  const original = unit.paragraphs[0];
  const exact = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(original))
    .find(part => part.index <= request.start && part.index + part.segment.length >= request.end);
  assert.equal(source.text, exact.segment);
  assert.equal(source.start, request.start - exact.index);
  assert.ok(!source.text.includes('Everyone'));
  assert.ok(!source.text.includes('How many'));
  assert.equal(source.textChs, f.reading.getReadingAnalysis(unit.attemptId).bilingualParagraphs[0].textChs);
  assert.equal(source.sourceUrl, unit.sourceUrl);
});

test('reading collection: rejects partial tokens, foreign words and malformed offsets without creating vocabulary', t => {
  const f = readingFixture(t); addCollectionVocabulary(f); const unit = f.open(1); f.submit(unit);
  const request = readingTokenRequest(f, unit, 3, 'cabinet');
  const before = new Database(f.contentPath, { readonly: true });
  let vocabularySize;
  try { vocabularySize = count(before, 'words'); } finally { before.close(); }
  assert.throws(() => f.readingCollection.collectFromReading({ ...request, start: request.start + 1 }), /完整单词/);
  assert.throws(() => f.readingCollection.collectFromReading({ ...request, end: request.end + 1 }), /完整单词/);
  assert.throws(() => f.readingCollection.collectFromReading({ ...request, paragraph: 99 }), /段落编号/);
  assert.throws(() => f.readingCollection.collectFromReading({ ...request, start: -1 }), /完整单词/);
  assert.throws(() => f.readingCollection.collectFromReading(readingTokenRequest(f, unit, 1, 'Noelle')), /本地词库未收录/);
  assert.equal(f.collection.listCollection().length, 0);
  const after = new Database(f.contentPath, { readonly: true });
  try { assert.equal(count(after, 'words'), vocabularySize); } finally { after.close(); }
});

test('reading collection: dialogue and reading share one deduplicated table and retain the first source after removal', t => {
  const f = readingFixture(t); addCollectionVocabulary(f); const unit = f.open(1); f.submit(unit);
  const request = readingTokenRequest(f, unit, 5, 'plate');
  const first = f.readingCollection.collectFromReading(request);
  assert.equal(first.status, 'added');
  const saved = f.collection.getCollectedSource(101);
  assert.equal(f.collect(8, 'plate').status, 'existing');
  assert.deepEqual(f.collection.getCollectedSource(101), saved);
  f.collection.removeCollectedWord(101);
  assert.equal(f.collect(8, 'plate').status, 'restored');
  assert.deepEqual(f.collection.getCollectedSource(101), saved);
  assert.equal(f.collection.listCollection().length, 1);
});

test('reading collection: a dialogue collected first remains the source after a reading click', t => {
  const f = readingFixture(t); addCollectionVocabulary(f);
  assert.equal(f.collect(8, 'plate').status, 'added');
  const saved = f.collection.getCollectedSource(101);
  assert.equal(saved.origin, 'dialogue');
  const unit = f.open(1); f.submit(unit);
  const request = readingTokenRequest(f, unit, 5, 'plate');
  assert.equal(f.readingCollection.collectFromReading(request).status, 'existing');
  assert.deepEqual(f.collection.getCollectedSource(101), saved);
  f.collection.removeCollectedWord(101);
  assert.equal(f.readingCollection.collectFromReading(request).status, 'restored');
  assert.deepEqual(f.collection.getCollectedSource(101), saved);
});

test('reading collection: later word self-test uses only its saved reading sentence', t => {
  const f = readingFixture(t); addCollectionVocabulary(f); const unit = f.open(1); f.submit(unit);
  f.readingCollection.collectFromReading(readingTokenRequest(f, unit, 3, 'plates'));
  const saved = f.collection.getCollectedSource(101);
  f.review(101, 3, '__collection__');
  const exercise = f.exercise.buildExercise('__collection__', 101);
  assert.equal(exercise.kind, 'collection');
  const payload = JSON.parse(f.progress.openProgressDb().prepare('SELECT payload_json FROM exercise_attempts WHERE id=?').get(exercise.id).payload_json);
  const restored = exercise.parts.map(part => part.text ?? payload.solutions.find(solution => solution.id === part.blankId).expected).join('');
  assert.equal(restored, saved.text);
  assert.ok(!restored.includes('Noelle!!!!!!'));
  const checked = f.exercise.submitExercise(exercise.id, Object.fromEntries(payload.solutions.map(solution => [solution.id, solution.expected])));
  assert.equal(checked.answers.every(answer => answer.correct), true);
});

function seedLegacyGroup(f, options = {}) {
  const owner = f.context.load('reading-bank').LEGACY_READING_BANK.find(unit => unit.level === 'sh_gaokao');
  const db = f.progress.openProgressDb(); f.reading.ensureReadingSchema(db);
  const id = 'legacy-group-round';
  const complete = Object.fromEntries(owner.questions.map(question => [question.id, question.expected]));
  const draft = options.submitted ? complete : (options.draft || {});
  const earned = options.submitted ? owner.questions.flatMap(question => f.rewards.grantReadingReward(owner, question, '2026-10-01T00:00:00.000Z')) : [];
  const questionResults = Object.fromEntries(owner.questions.map(question => [question.id, {
    questionId:question.id,correct:true,firstCorrect:true,attempts:1,earned:[],total:earned.length,
    rewarded:true,duplicate:false,assisted:false,hintUsed:false,
  }]));
  const result = options.submitted ? {attemptId:id,score:owner.questions.length,maxScore:owner.questions.length,
    correct:owner.questions.length,total:owner.questions.length,answers:complete,questionResults,
    earned,earnedCount:earned.length,rewardAnimationPending:true,duplicate:false,submittedAt:'2026-10-01T00:00:00.000Z',assisted:false} : null;
  db.prepare('INSERT INTO reading_sessions(id,unit_id,created_at,paper_version,draft_json,paper_result_json,answers_viewed_at) VALUES(?,?,?,2,?,?,?)')
    .run(id, owner.id, '2026-10-01T00:00:00.000Z', JSON.stringify(draft), result?JSON.stringify(result):null, options.exposed?'2026-10-01T00:00:01.000Z':null);
  if (options.submitted) for (const question of owner.questions) db.prepare('INSERT INTO reading_answers(attempt_id,question_id,first_answer,first_correct,last_answer,last_correct,attempts,last_assisted,hint_used,updated_at) VALUES(?,?,?,1,?,1,1,0,0,?)')
    .run(id, question.id, question.expected, question.expected, '2026-10-01T00:00:00.000Z');
  return {owner,id,complete};
}

test('independent reading: drafts, grading, PDF exposure and new rounds stay inside one reading', t => {
  const f=readingFixture(t), candidates=f.bank.filter(unit=>unit.level==='sh_gaokao'&&unit.paper);
  const a=f.reading.getReadingUnit(candidates[0].id), b=f.reading.getReadingUnit(candidates[1].id);
  const draft={[a.questions[0].id]:f.answers(a)[a.questions[0].id]};
  f.reading.saveReadingDraft(a.attemptId,draft);
  assert.deepEqual(f.reading.getReadingUnit(b.id).answers,{});
  assert.throws(()=>f.reading.submitReadingPaper(a.attemptId,{...f.answers(a),...f.answers(b)},'foreign-reading'),/本篇/);
  const score=f.submit(a);
  assert.equal(score.maxScore,a.questionCount);assert.equal(score.earnedCount,a.questionCount);
  assert.equal(f.reading.getReadingUnit(b.id).paperResult,null);
  f.reading.markReadingAnswersViewed(b.attemptId,b.id);
  const a2=f.reading.getReadingUnit(a.id,true);
  assert.equal(a2.answersViewed,false);assert.deepEqual(a2.answers,{});
  const bScore=f.submit(b);
  assert.equal(bScore.assisted,true);assert.equal(bScore.earnedCount,0);
  assert.equal(f.rewards.getRewards().readingTotal,a.questionCount);
});

test('independent reading: legacy drafts and answer exposure split without losing originals or granting rewards', t => {
  const f=readingFixture(t), owner=f.context.load('reading-bank').LEGACY_READING_BANK.find(unit=>unit.level==='sh_gaokao');
  const questions=[owner.paper.passages[0].questions[0],owner.paper.passages[1].questions[0]];
  const draft=Object.fromEntries(questions.map(question=>[question.id,question.expected]));
  const old=seedLegacyGroup(f,{draft,exposed:true}); const db=f.progress.openProgressDb();
  const original=db.prepare('SELECT * FROM reading_sessions WHERE id=?').get(old.id);
  for(const passage of owner.paper.passages){
    const unit=f.reading.getReadingUnit(passage.id);
    assert.deepEqual(unit.answers,Object.fromEntries(passage.questions.filter(question=>draft[question.id]).map(question=>[question.id,draft[question.id]])));
    assert.equal(unit.answersViewed,true);assert.equal(unit.paperResult,null);
    assert.equal(f.reading.getReadingUnit(passage.id).attemptId,unit.attemptId);
  }
  const migratedOriginal=db.prepare('SELECT * FROM reading_sessions WHERE id=?').get(old.id);
  assert.equal(migratedOriginal.content_revision,f.context.load('reading-package-store').getReadingContentRevision(owner.id));
  assert.deepEqual({...migratedOriginal,content_revision:original.content_revision},original);
  assert.equal(f.rewards.getRewards().total,0);assert.equal(count(db,'reading_split_migrations'),owner.paper.passages.length);
  assert.equal(f.reading.getReadingUnit(owner.id).id,owner.paper.passages[0].id);
  assert.throws(()=>f.reading.saveReadingDraft(old.id,draft),/独立阅读/);
});

test('independent reading: completed legacy scores split by question without replaying or duplicating rewards',t=>{
  const f=readingFixture(t),old=seedLegacyGroup(f,{submitted:true}),db=f.progress.openProgressDb();
  const ledger=db.prepare('SELECT * FROM reward_ledger ORDER BY id').all();
  for(const passage of old.owner.paper.passages){const unit=f.reading.getReadingUnit(passage.id);
    assert.equal(unit.paperResult.score,passage.questions.length);assert.equal(unit.paperResult.maxScore,passage.questions.length);
    assert.deepEqual(Object.keys(unit.paperResult.questionResults).sort(),passage.questions.map(q=>q.id).sort());
    assert.equal(unit.rewardAnimationPending,false);assert.deepEqual(unit.paperResult.earned,[]);
    assert.equal(f.reading.submitReadingPaper(unit.attemptId,unit.paperResult.answers,'migrated-'+passage.id).duplicate,true);
  }
  assert.deepEqual(db.prepare('SELECT * FROM reward_ledger ORDER BY id').all(),ledger);
  assert.equal(f.rewards.getRewards().readingTotal,old.owner.questions.length);
  const target=old.owner.paper.passages.at(-1),entry=f.rewards.getRewards().history.find(item=>item.questionId===target.questions[0].id);
  assert.equal(entry.unitId,target.id);assert.equal(entry.questionNumber,1);
  const again=f.reading.getReadingUnit(target.id,true);assert.equal(f.submit(again).earnedCount,0);
});

test('independent reading: an existing independent draft wins over historical group migration',t=>{
  const f=readingFixture(t),definition=f.bank.find(unit=>unit.level==='sh_gaokao'&&unit.paper);
  const current=f.reading.getReadingUnit(definition.id);const draft={[current.questions[0].id]:'B'};
  f.reading.saveReadingDraft(current.attemptId,draft);seedLegacyGroup(f,{submitted:true});
  const restored=f.reading.getReadingUnit(definition.id);
  assert.equal(restored.attemptId,current.attemptId);assert.deepEqual(restored.answers,draft);assert.equal(restored.paperResult,null);
});

test('independent reading: old question and paragraph locations map precisely and reject invalid requests',t=>{
  const f=readingFixture(t),resolve=f.context.load('reading-location').resolveReadingLocation;
  const old=f.context.load('reading-bank').LEGACY_READING_BANK.find(unit=>unit.level==='sh_gaokao');
  let offset=0;
  for(const passage of old.paper.passages){
    assert.deepEqual(resolve(old.id,{questionId:passage.questions[0].id}),{unitId:passage.id,questionId:passage.questions[0].id});
    assert.deepEqual(resolve(old.id,{paragraph:offset+1}),{unitId:passage.id,paragraph:1});offset+=passage.paragraphMap.length;
  }
  assert.throws(()=>resolve(old.id,{questionId:old.paper.passages[0].questions[0].id,paragraph:offset}),/不匹配/);
  assert.throws(()=>resolve(old.id,{paragraph:0}),/段落/);
  assert.throws(()=>resolve(old.paper.passages[0].id,{questionId:'foreign'}),/不属于/);
  assert.deepEqual(resolve(old.paper.passages[0].id,{unitId:'untrusted'}),{unitId:old.paper.passages[0].id});
});

test('independent reading: old collection locations resolve without rewriting the saved sentence or offsets',t=>{
  const f=readingFixture(t),old=f.context.load('reading-bank').LEGACY_READING_BANK.find(unit=>unit.level==='sh_gaokao');
  const passage=old.paper.passages.at(-1),offset=old.paper.passages.slice(0,-1).reduce((n,p)=>n+p.paragraphMap.length,0);
  const pair=f.reading.getReadingDocument(old.id).analysis.bilingualParagraphs[offset];
  const token=[...pair.textEn.matchAll(/[A-Za-z]+/g)][0];
  const saved={kind:'collection',origin:'reading',unitId:old.id,paragraph:offset+1,title:'Historical group title',sourceTitle:passage.sourceTitle,
    sourceUrl:passage.sourceUrl,coverPath:passage.coverPath,text:pair.textEn,textChs:pair.textChs,surface:token[0],start:token.index,end:token.index+token[0].length,collectedAt:'2026-10-01'};
  const raw=JSON.stringify(saved),db=f.progress.openProgressDb();
  db.prepare('INSERT INTO collected_words(word_id,created_at,source_json,active) VALUES(1,?,?,1)').run('2026-10-01',raw);
  const source=f.collection.getCollectedSource(1);
  assert.equal(source.unitId,passage.id);assert.equal(source.paragraph,1);assert.equal(source.text,saved.text);
  assert.equal(source.start,saved.start);assert.equal(source.end,saved.end);
  assert.equal(db.prepare('SELECT source_json FROM collected_words WHERE word_id=1').get().source_json,raw);
});


test('new reading batch: 19 independent readings retain 100 stable questions and reviewed official source pairs',t=>{
  const f=readingFixture(t), authored=f.bank.filter(unit=>unit.id.startsWith('content2-')).map(unit=>unit.paper.passages[0]);
  assert.equal(authored.length,19);assert.equal(authored.reduce((sum,unit)=>sum+unit.questions.length,0),100);
  assert.equal(new Set(authored.map(unit=>unit.materialId)).size,19,'Do not pad the new batch by repeating existing source texts');
  const existingMaterials=new Set(f.bank.filter(unit=>!unit.id.startsWith('content2-')).map(unit=>unit.materialId));
  const seenQuestions=new Set(); let questions=0;
  for(const definition of authored){
    assert.ok(!existingMaterials.has(definition.materialId));
    const unit=f.reading.getReadingUnit(definition.id),document=f.reading.getReadingDocument(definition.id);
    assert.equal(unit.kind,'single');assert.equal(unit.passageCount,1);assert.equal(unit.sections.length,1);
    assertNoSolutions(unit.questions);assert.equal(unit.questions.length,definition.questions.length);
    assert.equal(document.analysis.bilingualParagraphs.length,definition.paragraphMap.length);
    assert.ok(definition.analysis.overview.trim()&&definition.analysis.structure.length&&definition.analysis.sentences.length>=2);
    for(const sentence of document.analysis.sentences)assert.ok(document.analysis.bilingualParagraphs[sentence.paragraph-1].textEn.includes(sentence.text));
    for(const question of unit.questions){
      assert.ok(!seenQuestions.has(question.id));seenQuestions.add(question.id);
      const explanation=document.analysis.questions.find(item=>item.questionId===question.id);
      assert.ok(explanation?.explanation.trim()&&explanation.evidence.length);
      if(question.type==='choice'){
        assert.equal(explanation.optionExplanations.length,question.options.length,'Every distractor needs an explicit explanation');
        assert.deepEqual(explanation.optionExplanations.map(item=>item.id).sort(),question.options.map(item=>item.id).sort());
      }
    }
    const result=f.submit(unit);assert.equal(result.score,unit.questionCount);assert.equal(result.earnedCount,unit.questionCount);
    assert.equal(result.maxScore,unit.questionCount);questions+=unit.questionCount;
  }
  assert.equal(questions,100);assert.equal(f.rewards.getRewards().readingTotal,100);
  for(const [unitId,questionId,answer] of [
    ['content2-zk-roald-luhua-v1','content2-zk-roald-luhua-v1.animal','fox'],
    ['content2-zk-yoimiya-conversation-v1','content2-zk-yoimiya-conversation-v1.exchange','response'],
  ]){
    const unit=f.reading.getReadingUnit(unitId,true),answers={...f.answers(unit),[questionId]:answer};
    const result=f.submit(unit,answers);assert.equal(result.score,unit.questionCount);assert.equal(result.earnedCount,0);
  }
});
