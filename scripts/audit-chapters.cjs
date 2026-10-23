const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const Database=require('better-sqlite3'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
const filename=path.join(root,'src/main/chapter-catalog.ts');
const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const exports2={};new Function('exports','require',code)(exports2,require);
const dbPath=path.join(process.env.GENSHINWORDS_CONTENT_DIR||path.join(root,'content'),'content.db');
const db=new Database(dbPath,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
try {
  const all=exports2.chapterCatalog(db).entries,visible=exports2.browsableChapters(db);
  const groups=new Map();
  for(const row of all){const name=(row.title_chs||row.title_en).trim();if(!name)continue;const group=groups.get(name)||[];group.push(row);groups.set(name,group);}
  const duplicates=Array.from(groups,([title,rows])=>({title,rows})).filter(group=>group.rows.length>1);
  const exact=[];
  for(const group of duplicates){
    const hashes=new Map();
    for(const row of group.rows){
      if(!row.dialogue_count)continue;
      const lines=db.prepare("SELECT coalesce(d.speaker,'')||char(9)||coalesce(d.text_en,'')||char(9)||coalesce(d.text_chs,'') AS value FROM dialog_lines d JOIN quests q ON q.id=d.quest_id WHERE q.chapter_id=? ORDER BY q.sort_order,q.id,d.sort_order,d.id").all(row.id);
      const hash=crypto.createHash('sha256').update(lines.map(line=>line.value).join('\n')).digest('hex');
      const ids=hashes.get(hash)||[];ids.push(row.id);hashes.set(hash,ids);
    }
    for(const [sha256,ids] of hashes)if(ids.length>1)exact.push({title:group.title,ids,sha256});
  }
  const report={
    checked_at:new Date().toISOString(),readonly:true,
    source_db_sha256:crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'),
    summary:{source_chapters:all.length,visible_chapters:visible.length,same_title_groups:duplicates.length,same_title_chapters:duplicates.reduce((n,g)=>n+g.rows.length,0),same_text_groups:exact.length,empty_same_title_chapters:duplicates.flatMap(group=>group.rows).filter(row=>!row.dialogue_count).length,unknown_version:visible.filter(row=>!row.version).length},
    verified_corrections:all.filter(row=>exports2.CHAPTER_CORRECTIONS[row.id]).map(row=>({id:row.id,title:row.title_chs,type:row.type,version:row.version,original_type:row.original_type,original_version:row.original_version,variant:row.variant_label})),
    same_title_groups:duplicates.map(group=>({title:group.title,entries:group.rows.map(row=>({id:row.id,type:row.type,version:row.version,variant:row.variant_label,dialogue_count:row.dialogue_count,same_text_count:row.duplicate_text_count||1}))})),
    same_text_groups:exact,
    hidden_source_ids:all.filter(row=>!visible.includes(row)).map(row=>row.id),
    policy:'原始数据库、source ID和对话图均保留；同名用内容副标题或稳定顺序区分，同文单独标注；未知iq仅显示其他任务，未经核实的版本不作为iq筛选标签。其他类别现有数字版本尚未逐条人工核实。'
  };
  const at=process.argv.indexOf('--output');
  if(at>=0){if(!process.argv[at+1])throw Error('--output needs a file');const target=path.resolve(process.argv[at+1]);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n',{encoding:'utf8'});}
  console.log(JSON.stringify({ok:true,...report.summary,source_db_sha256:report.source_db_sha256},null,2));
}finally{db.close();}
