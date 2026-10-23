const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {gzipSync}=require('node:zlib');
const {createHash}=require('node:crypto');
const {fixture}=require('./helpers/practice-fixture.cjs');
const {loadMain,root}=require('./helpers/load-main.cjs');
const templates=new Map();
function packageFixture(t){
  const f=fixture(t,{bundledReadingPackagePath:null});
  return {...f,format:f.context.load('reading-package-format'),store:f.context.load('reading-package-store'),reading:f.context.load('reading')};
}
function dataFor(f,{packageId='test.reading.one',unitId='test-reading-one',version='1.0.0',template='content3-entry-sayu-sleep-v1'}={}){
  if(!templates.has(template)){
    const base=f.format.decodeReadingPackage(fs.readFileSync(path.join(root,'content/reading/base.gwreading'))).data;
    const entry=base.units.find(entry=>entry.definition.id===template);assert.ok(entry,'Missing template');
    const definition=entry.definition;
    templates.set(template,{format:base.format,formatVersion:base.formatVersion,manifest:{...base.manifest,id:packageId,name:'离线阅读测试包',version},
      units:[{...entry,composition:'independent'}],legacyGroups:[],sources:base.sources.filter(source=>source.id===definition.materialId),images:base.images.filter(image=>image.path===definition.coverPath)});
  }
  const data=structuredClone(templates.get(template));data.manifest.id=packageId;data.manifest.version=version;
  data.units[0].definition.id=unitId;delete data.units[0].legacyGroupId;
  return data;
}
function fileFor(f,data,name=data.manifest.id+'-'+data.manifest.version+'.gwreading'){
  const file=path.join(f.directory,name);fs.writeFileSync(file,f.format.encodeReadingPackage(data));return file;
}
async function install(f,data,name){const preview=await f.store.previewReadingPackageFile(fileFor(f,data,name));return f.store.importReadingPackage(preview.token);}
function answers(data){return Object.fromEntries(data.units[0].definition.questions.map(question=>[question.id,question.expected]));}
function revise(data,version='1.1.0'){
  const next=structuredClone(data);next.manifest.version=version;next.units[0].definition.title+=' · 新版';
  next.units[0].definition.analysis.overview+=' 这是新版讲解。';next.units[0].definition.coverFocus.x=.45;return next;
}
function reopen(f){return loadMain(f.contentPath,f.progressPath,{bundledReadingPackagePath:null});}

test('reading packages: self-contained clean import works without materials.db or loose images',async t=>{
  const f=packageFixture(t),data=dataFor(f);assert.deepEqual(f.reading.listReadingUnits(),[]);
  assert.equal(fs.existsSync(path.join(f.directory,'materials.db')),false);assert.equal(fs.existsSync(path.join(f.directory,'images')),false);
  const preview=await f.store.previewReadingPackageFile(fileFor(f,data));assert.equal(preview.action,'install');assert.equal(preview.package.unitCount,1);
  assert.equal(f.reading.listReadingUnits().length,0,'Preview must not install');
  assert.equal((await f.store.importReadingPackage(preview.token)).action,'installed');
  const unit=f.reading.getReadingUnit(data.units[0].definition.id),document=f.reading.getReadingDocument(unit.id,unit.attemptId);
  assert.equal(unit.questions.length,3);assert.equal(document.analysis.bilingualParagraphs.length,5);assert.ok(document.analysis.bilingualParagraphs.every(pair=>pair.textEn&&pair.textChs));
  assert.match(unit.coverPath,/^gwreading\/[a-f0-9]{64}\/[a-f0-9]{64}\.(?:png|jpg|webp)$/);
  const banner=await f.context.load('reading-artwork').getReadingBannerBuffer(unit.id,undefined,unit.attemptId);
  const meta=await require('sharp')(banner).metadata();assert.equal(meta.width,1600);assert.equal(meta.height,400);
  const result=f.reading.submitReadingPaper(unit.attemptId,answers(data),'clean-import-submit');assert.equal(result.score,3);assert.equal(result.earnedCount,3);
});

test('reading packages: repeated packages and shared logical questions never award twice',async t=>{
  const f=packageFixture(t),one=dataFor(f);await install(f,one);
  const first=f.reading.getReadingUnit(one.units[0].definition.id);f.reading.submitReadingPaper(first.attemptId,answers(one),'shared-first');
  assert.equal((await install(f,one)).action,'unchanged');assert.equal(f.reading.listReadingUnits().length,1);
  const two=dataFor(f,{packageId:'test.reading.two',unitId:'test-reading-two'});await install(f,two);
  const second=f.reading.getReadingUnit(two.units[0].definition.id),result=f.reading.submitReadingPaper(second.attemptId,answers(two),'shared-second');
  assert.equal(result.score,3);assert.equal(result.earnedCount,0);assert.equal(f.rewards.getRewards().readingTotal,3);
  const coOwner=structuredClone(one);coOwner.manifest.id='test.reading.co-owner';await install(f,coOwner);
  assert.equal(f.reading.listReadingUnits().length,2,'Identical co-owned passage appears once');assert.equal(f.store.listReadingPackages().length,3);
});

test('reading packages: upgrades keep old drafts, scores, collection, rewards and historical content across restart',async t=>{
  const f=packageFixture(t),one=dataFor(f);await install(f,one);f.collect(2,'harbor');
  const beforeCollection=f.context.load('collections').listCollection(),old=f.reading.getReadingUnit(one.units[0].definition.id);
  const draft={[old.questions[0].id]:answers(one)[old.questions[0].id]};f.reading.saveReadingDraft(old.attemptId,draft);
  const before=f.reading.getReadingDocument(old.id,old.attemptId),two=revise(one);assert.equal((await install(f,two)).action,'upgraded');
  const restored=f.reading.getReadingUnit(old.id);assert.equal(restored.attemptId,old.attemptId);assert.equal(restored.title,old.title);assert.deepEqual(restored.answers,draft);
  assert.equal(restored.contentVersion,'1.0.0');assert.equal(restored.updateAvailable,true);assert.deepEqual(f.reading.getReadingDocument(old.id,old.attemptId).analysis,before.analysis);
  assert.equal(f.reading.submitReadingPaper(old.attemptId,answers(one),'old-version-submit').score,3);
  const fresh=f.reading.getReadingUnit(old.id,true);assert.equal(fresh.contentVersion,'1.1.0');assert.equal(fresh.title,two.units[0].definition.title);
  assert.equal(f.reading.submitReadingPaper(fresh.attemptId,answers(two),'new-version-submit').earnedCount,0);
  assert.deepEqual(f.context.load('collections').listCollection(),beforeCollection);assert.equal(f.rewards.getRewards().readingTotal,3);
  f.context.close();const context=reopen(f);
  try{const reading=context.load('reading');assert.deepEqual(reading.getReadingDocument(old.id,old.attemptId).analysis,before.analysis);
    assert.equal(reading.getReadingAnalysis(old.attemptId).overview,before.analysis.overview);
    assert.equal(context.load('rewards').getRewards().readingTotal,3);assert.deepEqual(context.load('collections').listCollection(),beforeCollection);
  }finally{context.close();}
});

test('reading packages: removing a passage from a new version retains its archived attempt and old link',async t=>{
  const f=packageFixture(t),one=dataFor(f);await install(f,one);const old=f.reading.getReadingUnit(one.units[0].definition.id);
  f.reading.saveReadingDraft(old.attemptId,{[old.questions[0].id]:answers(one)[old.questions[0].id]});
  const two=revise(one);two.units[0].definition.id='test-replacement-reading';await install(f,two);
  assert.deepEqual(f.reading.listReadingUnits().map(unit=>unit.id),['test-replacement-reading']);
  assert.equal(f.reading.getReadingUnit(old.id).attemptId,old.attemptId);
  assert.equal(f.context.load('reading-location').resolveReadingLocation(old.id,{questionId:old.questions[0].id}).unitId,old.id);
  assert.equal(f.reading.submitReadingPaper(old.attemptId,answers(one),'removed-old-submit').score,3);
  const archivedReview=f.reading.getReadingUnit(old.id,true);assert.equal(archivedReview.contentVersion,'1.0.0');
  assert.equal(f.reading.submitReadingPaper(archivedReview.attemptId,answers(one),'archived-review-submit').earnedCount,0);
});

test('reading packages: version, unit and logical-question conflicts are rejected without changing active content',async t=>{
  const f=packageFixture(t),one=dataFor(f);await install(f,one);
  const before=f.reading.getReadingDocument(one.units[0].definition.id),same=revise(one,'1.0.0');
  await assert.rejects(f.store.previewReadingPackageFile(fileFor(f,same,'same-version-different.gwreading')));
  const lower=structuredClone(one);lower.manifest.version='0.9.0';await assert.rejects(f.store.previewReadingPackageFile(fileFor(f,lower)));
  const grading=revise(one),q=grading.units[0].definition.questions[0],option=q.options.find(option=>option.id!==q.expected);
  q.expected=option.id;q.solution.answerId=option.id;q.solution.answer=option.text;
  await assert.rejects(f.store.previewReadingPackageFile(fileFor(f,grading,'grading-conflict.gwreading')));
  grading.manifest.id='test.reading.conflict';grading.units[0].definition.id='test-conflicting-logical-question';
  await assert.rejects(f.store.previewReadingPackageFile(fileFor(f,grading,'other-package-grading-conflict.gwreading')));
  const unitConflict=dataFor(f,{packageId:'test.unit.conflict'});unitConflict.units[0].definition.title+='不同内容';
  await assert.rejects(f.store.previewReadingPackageFile(fileFor(f,unitConflict)));
  assert.deepEqual(f.reading.getReadingDocument(one.units[0].definition.id),before);
});

test('reading packages: legacy alias IDs cannot be hijacked by a different package',async t=>{
  const f=packageFixture(t),one=dataFor(f);one.legacyGroups=[{id:'test-legacy-alias',title:'旧链接',level:'entry',background:'旧版资料',estimatedMinutes:5,passages:[{unitId:one.units[0].definition.id}]}];
  await install(f,one);const two=dataFor(f,{packageId:'test.alias.hijack',unitId:'test-legacy-alias'});
  await assert.rejects(f.store.previewReadingPackageFile(fileFor(f,two)));
  assert.equal(f.reading.listReadingUnits().length,1);
});

test('reading packages: adding another blank does not change identities of unchanged questions',t=>{
  const f=packageFixture(t),full=dataFor(f,{template:'content3-zk-kokomi-seaside-v1'}),smaller=structuredClone(full);
  const removed=smaller.units[0].definition.questions.pop();smaller.units[0].definition.masks=smaller.units[0].definition.masks.filter(mask=>mask.questionId!==removed.id);
  const a=f.format.validateReadingPackage(full),b=f.format.validateReadingPackage(smaller);
  for(const q of smaller.units[0].definition.questions)assert.equal(a.questionFingerprints[q.id],b.questionFingerprints[q.id]);
});

test('reading packages: package mutation between preview and commit is rejected',async t=>{
  const f=packageFixture(t),one=dataFor(f),file=fileFor(f,one),preview=await f.store.previewReadingPackageFile(file);
  fs.writeFileSync(file,f.format.encodeReadingPackage(revise(one)));
  await assert.rejects(f.store.importReadingPackage(preview.token));assert.deepEqual(f.reading.listReadingUnits(),[]);
});

test('reading packages: registry write failure leaves active data and learning records intact',async t=>{
  const f=packageFixture(t),one=dataFor(f);await install(f,one);const first=f.reading.getReadingUnit(one.units[0].definition.id);
  f.reading.saveReadingDraft(first.attemptId,{[first.questions[0].id]:answers(one)[first.questions[0].id]});
  const registry=path.join(f.context.readingPackagesDir,'registry.json'),before=fs.readFileSync(registry),two=revise(one);
  const preview=await f.store.previewReadingPackageFile(fileFor(f,two)),rename=fs.renameSync;
  fs.renameSync=function(from,to){if(path.resolve(to)===path.resolve(registry))throw Object.assign(Error('injected registry write failure'),{code:'EPERM'});return rename.apply(this,arguments);};
  try{await assert.rejects(f.store.importReadingPackage(preview.token),/injected/);}finally{fs.renameSync=rename;}
  assert.ok(fs.readFileSync(registry).equals(before));assert.equal(f.reading.getReadingUnit(first.id).attemptId,first.attemptId);
  assert.equal(f.reading.getReadingUnit(first.id).contentVersion,'1.0.0');assert.equal(f.reading.listReadingUnits()[0].title,first.title);
});

test('reading packages: a damaged installed package is isolated and reimport repairs the same version',async t=>{
  const f=packageFixture(t),one=dataFor(f),two=dataFor(f,{packageId:'test.reading.two',unitId:'test-reading-two'});
  await install(f,one);await install(f,two);const digest=f.format.validateReadingPackage(one).digest;
  f.context.close();fs.writeFileSync(path.join(f.context.readingPackagesDir,'revisions',digest+'.gwreading'),'damaged');
  const context=reopen(f);
  try{const store=context.load('reading-package-store'),reading=context.load('reading');
    assert.deepEqual(reading.listReadingUnits().map(unit=>unit.id),['test-reading-two']);
    assert.ok(store.listReadingPackages().some(pack=>pack.id===one.manifest.id&&pack.status==='error'));
    const preview=await store.previewReadingPackageFile(fileFor(f,one,'repair.gwreading'));assert.equal((await store.importReadingPackage(preview.token)).action,'unchanged');
    assert.equal(reading.listReadingUnits().length,2);assert.ok(store.listReadingPackages().every(pack=>pack.status==='active'));
  }finally{context.close();}
});

test('reading packages: missing image disables only its own revision and can be restored',async t=>{
  const f=packageFixture(t),one=dataFor(f);await install(f,one);const valid=f.format.validateReadingPackage(one),image=one.images[0];
  f.context.close();fs.unlinkSync(path.join(f.context.readingPackagesDir,'assets',valid.digest,image.sha256+'.'+(image.mimeType==='image/jpeg'?'jpg':image.mimeType.split('/')[1])));
  const context=reopen(f);
  try{const store=context.load('reading-package-store');assert.equal(context.load('reading').listReadingUnits().length,0);
    const preview=await store.previewReadingPackageFile(fileFor(f,one,'image-repair.gwreading'));await store.importReadingPackage(preview.token);
    assert.equal(context.load('reading').listReadingUnits().length,1);
  }finally{context.close();}
});

const invalids=[
 ['unsupported format',d=>{d.formatVersion=99;}],['future program',d=>{d.manifest.minAppVersion='99.0.0';}],['unsupported engine',d=>{d.manifest.engineVersion=99;}],
 ['source hash',d=>{d.sources[0].en.text+=' changed';}],['source paragraph order',d=>{d.sources[0].en.paragraphs.reverse();}],
 ['missing image',d=>{d.images=[];}],['resource hash',d=>{d.images[0].sha256='0'.repeat(64);}],
 ['traversal',d=>{d.images[0].path='../../escape.webp';d.units[0].definition.coverPath=d.images[0].path;}],
 ['absolute path',d=>{d.images[0].path='C:/escape.webp';d.units[0].definition.coverPath=d.images[0].path;}],
 ['backslash path',d=>{d.images[0].path='assets\\escape.webp';d.units[0].definition.coverPath=d.images[0].path;}],
 ['executable resource',d=>{d.images[0].mimeType='image/svg+xml';}],['unsupported grading',d=>{d.units[0].definition.questions[0].type='essay';}],
 ['duplicate question',d=>{d.units[0].definition.questions.push(structuredClone(d.units[0].definition.questions[0]));}],
 ['invalid evidence',d=>{d.units[0].definition.questions[0].solution.evidence=[99999];}],
 ['answer explanation mismatch',d=>{d.units[0].definition.questions[0].solution.answer='an unrelated answer';}],
 ['reserved object ID',d=>{d.manifest.id='toString';}],['executable field',d=>{d.script='process.exit()';}],
 ['mapping outside source',d=>{d.units[0].definition.paragraphMap[0].en=99999;}],
];
for(const [name,mutate]of invalids)test('reading packages: reject '+name+' before installation',async t=>{
  const f=packageFixture(t),data=dataFor(f);mutate(data);
  assert.throws(()=>f.format.validateReadingPackage(data,{appVersion:'1.0.0'}));const file=path.join(f.directory,'invalid.gwreading');fs.writeFileSync(file,gzipSync(Buffer.from(JSON.stringify(data),'utf8')));
  await assert.rejects(f.store.previewReadingPackageFile(file));assert.equal(f.reading.listReadingUnits().length,0);
});

test('reading packages: reject exact-mask and accepted-first-letter errors',t=>{
  const f=packageFixture(t),masked=dataFor(f,{template:'content3-zk-kokomi-seaside-v1'});masked.units[0].definition.masks[0].start++;
  assert.throws(()=>f.format.validateReadingPackage(masked));
  const initials=dataFor(f,{template:'content3-zk-diona-storm-v1'});initials.units[0].definition.questions[0].accepted=['incorrect'];
  assert.throws(()=>f.format.validateReadingPackage(initials));
});

test('reading packages: truncated, invalid-UTF8 and oversized compressed inputs are bounded',t=>{
  const f=packageFixture(t),valid=f.format.encodeReadingPackage(dataFor(f));assert.throws(()=>f.format.decodeReadingPackage(valid.subarray(0,valid.length-4)));
  assert.throws(()=>f.format.decodeReadingPackage(gzipSync(Buffer.from([0xff,0xfe,0x7b,0x7d]))));
  const limit=f.format.READING_PACKAGE_LIMITS.decompressedBytes;
  const bomb=gzipSync(Buffer.alloc(limit+1,32));assert.throws(()=>f.format.decodeReadingPackage(bomb),/超过|损坏/);
});


test('reading package author CLI: data files alone produce an importable package without application build',async t=>{
  const f=packageFixture(t),{spawnSync}=require('node:child_process');
  const author=path.join(f.directory,'author-source');fs.cpSync(path.join(root,'reading-library/examples/shared-question'),author,{recursive:true});
  const unitDir=path.join(author,'units'),name=fs.readdirSync(unitDir).find(name=>name.endsWith('.json'));
  const extra=JSON.parse(fs.readFileSync(path.join(unitDir,name),'utf8'));extra.definition.id='test-extra-authored-reading';extra.definition.title+=' · 新篇目';
  fs.writeFileSync(path.join(unitDir,'999-extra.json'),JSON.stringify(extra,null,2),'utf8');
  const target=path.join(f.directory,'authored.gwreading'),script=path.join(root,'scripts/reading-package.cjs');
  for(const args of [['validate',author],['pack',author,'--out',target],['validate',target]]){
    const result=spawnSync(process.execPath,[script,...args],{cwd:f.directory,encoding:'utf8',windowsHide:true,env:{...process.env,GENSHINWORDS_CONTENT_DIR:path.join(f.directory,'missing-materials')}});
    assert.equal(result.status,0,(result.stdout||'')+(result.stderr||''));
  }
  const data=f.format.decodeReadingPackage(fs.readFileSync(target)).data;assert.equal(data.units.length,2);
  const preview=await f.store.previewReadingPackageFile(target);await f.store.importReadingPackage(preview.token);assert.equal(f.reading.listReadingUnits().length,2);
});

test('reading package author CLI: source-image file paths cannot leave the author directory',t=>{
  const f=packageFixture(t),{spawnSync}=require('node:child_process');
  const author=path.join(f.directory,'unsafe-author-source');fs.cpSync(path.join(root,'reading-library/examples/shared-question'),author,{recursive:true});
  const metadata=path.join(author,'images.json'),images=JSON.parse(fs.readFileSync(metadata,'utf8'));
  const external=path.join(f.directory,'outside.webp');fs.writeFileSync(external,Buffer.from(dataFor(f).images[0].dataBase64,'base64'));
  images[0].file='../outside.webp';fs.writeFileSync(metadata,JSON.stringify(images,null,2),'utf8');
  const target=path.join(f.directory,'must-not-exist.gwreading');
  const result=spawnSync(process.execPath,[path.join(root,'scripts/reading-package.cjs'),'pack',author,'--out',target],{cwd:f.directory,encoding:'utf8',windowsHide:true});
  assert.notEqual(result.status,0);assert.equal(fs.existsSync(target),false);
});
