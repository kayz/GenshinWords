const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {loadMain,root}=require('./helpers/load-main.cjs');
const baseline=require('./fixtures/reading-migration-baseline.json');
function canonical(value,key=''){
  if(key==='coverPath'&&typeof value==='string'){
    const match=/^gwreading\/[a-f0-9]{64}\/([a-f0-9]{64})\.(?:webp|png|jpe?g)$/.exec(value);
    return match?match[1]:(baseline.imageHashes[value]||value);
  }
  if(Array.isArray(value))return value.map(item=>canonical(item));
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>[key,canonical(value[key],key)]));
  return value;
}
function sha(value){return createHash('sha256').update(JSON.stringify(canonical(value)),'utf8').digest('hex');}
test('reading package migration: every existing passage, question, source, explanation and illustration retains its content',()=>{
  const context=loadMain(path.join(root,'content/content.db'));
  try{
    const reading=context.load('reading'),bank=context.load('reading-bank');
    assert.ok(bank.READING_BANK.length>=baseline.units.length);
    let questions=0;
    for(const expected of baseline.units){
      const document=reading.getReadingDocument(expected.id);
      assert.deepEqual(document.unit.questions.map(question=>question.id),expected.questionIds,expected.id+': stable question IDs');
      const actual={unit:Object.fromEntries(expected.fields.map(key=>[key,document.unit[key]])),analysis:document.analysis};
      assert.equal(sha(actual),expected.sha256,expected.id+': migrated public content differs');
      questions+=document.unit.questions.length;
    }
    assert.equal(baseline.units.length,69);assert.equal(questions,381);
    for(const expected of baseline.legacyUnits){
      const unit=bank.LEGACY_READING_BANK.find(unit=>unit.id===expected.id);
      assert.ok(unit,expected.id+': historical group alias is missing');
      assert.equal(sha(Object.fromEntries(expected.fields.map(key=>[key,unit[key]]))),expected.sha256,expected.id+': historical mapping differs');
    }
  }finally{context.close();}
});
