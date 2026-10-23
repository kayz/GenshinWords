const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Database=require('better-sqlite3');
const {fixture}=require('./helpers/practice-fixture.cjs');
function bulkWords(f) {
  const db=new Database(f.contentPath);
  const insert=db.prepare("INSERT INTO words(id,lemma,translation,phonetic,pos) VALUES(?,?,?,'','')");
  const member=db.prepare("INSERT INTO book_words VALUES('test',?,?)");
  db.transaction(()=>{for(let id=100;id<220;id++){insert.run(id,'fixture'+id,'测试词'+id);member.run(id,id);}})();
  db.close();
}
test('首页数量设置规范化，合法数量和马拉松持久保存',t=>{
  const f=fixture(t),{handlers}=f.context.load('ipc');
  const {normalizeStudySize}=f.context.load('../shared/study-settings');
  assert.equal(normalizeStudySize('old'), '10');
  assert.equal(normalizeStudySize(null), '10');
  for(const size of ['10','20','50','100','marathon']){
    handlers['settings:set']({},'studySize',size);
    assert.equal(handlers['settings:get']({},'studySize'),size);
  }
  assert.throws(()=>handlers['settings:set']({},'studySize','200'),/请选择本轮学习数量/);
});
test('固定10/20/50/100个为到期词和新词的合计，到期词优先且无重复',t=>{
  const f=fixture(t);bulkWords(f);
  const dueIds=[1,3,4,6,7,8,9,10,11,12,13,14];
  for(const id of dueIds){const row=f.study.ensureCard(id,'test');f.progress.upsertCard({...row,reps:1,state:2,due:'2020-01-01T00:00:00.000Z'});}
  for(const limit of [10,20,50,100]){
    const ids=f.study.buildStudyBatch('test',{limit});
    assert.equal(ids.length,limit);assert.equal(new Set(ids).size,limit);
    assert.ok(ids.slice(0,Math.min(limit,dueIds.length)).every(id=>dueIds.includes(id)));
  }
  assert.equal(f.study.buildStudyBatch('test',{limit:20,dueOnly:true}).length,dueIds.length);
});
test('马拉松继续取新词，已出现的词仅在实际到期后允许重学',t=>{
  const f=fixture(t);bulkWords(f);
  const first=f.study.buildStudyBatch('test',{limit:20,repeatDue:true});
  const next=f.study.buildStudyBatch('test',{limit:20,repeatDue:true,excludeNewIds:first});
  assert.equal(first.length,20);assert.equal(next.length,20);
  assert.ok(next.every(id=>!first.includes(id)));
  const id=first[0],row=f.study.ensureCard(id,'test');
  f.progress.upsertCard({...row,reps:1,state:1,due:'2999-01-01T00:00:00.000Z'});
  assert.ok(!f.study.buildStudyBatch('test',{limit:20,repeatDue:true,excludeNewIds:first}).includes(id));
  f.progress.upsertCard({...row,reps:1,state:1,due:'2020-01-01T00:00:00.000Z'});
  assert.equal(f.study.buildStudyBatch('test',{limit:20,repeatDue:true,excludeNewIds:first})[0],id);
  assert.ok(!f.study.buildStudyBatch('test',{limit:20,repeatDue:false,excludeNewIds:first}).includes(id));
  for(const request of [{limit:0},{limit:101},{limit:NaN},{limit:10,excludeNewIds:[-1]},{limit:10,repeatDue:'yes'}])assert.throws(()=>f.study.buildStudyBatch('test',request));
});
test('未知iq不冒充邀约；龙与山为三个5.0委托分支，筛选和同名标注一致',t=>{
  const f=fixture(t),db=new Database(f.contentPath);
  const insert=db.prepare("INSERT INTO chapters(id,type,title_en,title_chs,version,cover_path) VALUES(?,?,?,?,?,?)");
  for(const id of [25029,25033,25034])insert.run(id,'iq','Saurian Versus Mountain','龙与山','1.3','old.jpg');
  insert.run(555,'iq','Unknown task','待整理的任务','1.3','old.jpg');
  insert.run(556,'wq','Invalid version','错误版本字段','Story Quests','old.jpg');
  insert.run(558,'aq','Luna chapter','月版本任务','Luna IV','');
  insert.run(557,'iq','Hidden test','(test)隐藏$HIDDEN','1.3','old.jpg');db.close();
  const list=f.content.listChapters('5.0','commission');
  assert.deepEqual(list.map(row=>row.id),[25029,25033,25034]);
  assert.equal(new Set(list.map(row=>row.variant_label)).size,3);
  assert.ok(list.every(row=>row.variant_count===3&&row.source_label==='每日委托'&&row.original_version==='1.3'));
  assert.equal(f.content.getChapter(555).type,'other');
  assert.equal(f.content.getChapter(555).version,'');
  assert.equal(f.content.getChapter(556).version,'');
  assert.ok(!f.content.listChapters().some(row=>row.id===557));
  assert.ok(f.content.getChapter(557),'Hidden source remains addressable');
  assert.equal(f.content.listSourceTypes().find(row=>row.type==='commission').chapter_count,3);
  assert.ok(!f.content.listVersions().some(row=>row.version==='Story Quests'));
  assert.equal(f.content.listChapters('Luna IV')[0].id,558);
});
test('同文来源可识别，独立source ID和对话图不合并删除',t=>{
  const f=fixture(t),db=new Database(f.contentPath);
  db.exec("INSERT INTO chapters(id,type,title_en,title_chs,version,cover_path) VALUES(2,'aq','Fixture chapter','测试章节','1',''); INSERT INTO quests(id,chapter_id,title_en,title_chs) VALUES(2,2,'Another graph','另一图'); INSERT INTO dialog_lines(id,quest_id,speaker,text_en,text_chs,sort_order) SELECT id+100,2,speaker,text_en,text_chs,sort_order FROM dialog_lines WHERE quest_id=1;");
  db.close();
  const both=f.content.listChapters();
  assert.equal(both.length,2);
  assert.ok(both.every(row=>row.duplicate_text_count===2));
  assert.notEqual(f.content.listQuests(1)[0].id,f.content.listQuests(2)[0].id);
});
test('占位头像使用真实名字的首字，不切断Unicode字符；ICO含完整Windows尺寸',t=>{
  const f=fixture(t),{speakerInitial}=f.context.load('../shared/speaker-initial');
  for(const [name,initial] of [['Katheryne','K'],['凯瑟琳','凯'],['  「阿守」','阿'],['𠮷田','𠮷'],['','旁'],[null,'旁']])assert.equal(speakerInitial(name),initial);
  const ico=fs.readFileSync(path.join(__dirname,'../resources/icon.ico'));
  assert.equal(ico.readUInt16LE(2),1);
  const sizes=Array.from({length:ico.readUInt16LE(4)},(_,i)=>ico[6+i*16]||256);
  assert.deepEqual(sizes,[16,20,24,32,40,48,64,128,256]);
  for(let i=0;i<sizes.length;i++){const at=6+i*16,offset=ico.readUInt32LE(at+12),length=ico.readUInt32LE(at+8);assert.ok(offset+length<=ico.length);assert.equal(ico.subarray(offset,offset+8).toString('hex'),'89504e470d0a1a0a');}
});

test('评分请求绑定评级，同操作重试不重复推进，不同选择不得静默复用',t=>{
  const f=fixture(t);
  const first=f.study.reviewCard(3,'test',3,'bound-grade');
  const before=f.progress.openProgressDb().prepare("SELECT count(*) n FROM review_logs WHERE word_id=3 AND book_id='test'").get().n;
  const retry=f.study.reviewCard(3,'test',3,'bound-grade');
  assert.equal(retry.duplicate,true);assert.equal(retry.due,first.due);
  assert.throws(()=>f.study.reviewCard(3,'test',1,'bound-grade'),/最初的选择/);
  assert.equal(f.progress.openProgressDb().prepare("SELECT count(*) n FROM review_logs WHERE word_id=3 AND book_id='test'").get().n,before);
});
test('台本PDF缺头像与有头像采用同一文本缩进，换页后不沿用旧页行高',t=>{
  const f=fixture(t),{drawDialogueLine}=f.context.load('pdf');
  function drawing(cross=false){
    const page=()=>({width:595,height:842,margins:{left:48,right:48,top:48,bottom:48}});
    const d={page:page(),y:700,x:48,texts:[],circles:0};
    for(const method of ['font','fontSize','fillColor','save','restore','fill','fillAndStroke','rect','image'])d[method]=()=>d;
    d.circle=()=>{d.circles++;return d;};
    d.widthOfString=text=>text.length*5;
    d.text=(text,x,y)=>{d.texts.push({text,x,y});if(cross&&text==='跨页'){d.page=page();d.y=60;}else d.y=y+12;return d;};
    d.addPage=()=>{d.page=page();d.y=48;return d;};
    d.moveDown=()=>{d.y+=3;return d;};return d;
  }
  const plain=drawing(),pictured=drawing();
  const row={speaker:'凯瑟琳',text_en:'Alpha beta.',text_chs:'中文'};
  drawDialogueLine(plain,row,null,new Set(),new Set(),'test');
  drawDialogueLine(pictured,row,Buffer.from('image'),new Set(),new Set(),'test');
  assert.equal(plain.circles,1);assert.equal(pictured.circles,0);
  assert.ok(plain.texts.some(item=>item.text==='凯'));
  assert.equal(plain.texts.find(item=>item.text==='Alpha').x,84);
  assert.equal(pictured.texts.find(item=>item.text==='Alpha').x,84);
  const crossed=drawing(true);
  drawDialogueLine(crossed,{...row,text_chs:'跨页'},null,new Set(),new Set(),'test');
  assert.equal(crossed.y,63);
});
