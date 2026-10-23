import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Chapter } from '../shared/models';

interface ChapterRow extends Chapter {}
interface KnownChapter { type:string; source_label:string; version:string; variant_label?:string; cover_path?:string; cover_source_url?:string; cover_focus?:{x:number;y:number} }
const NATLAN_ART = 'reading-headers/art_1187c113e289d8f4379a76e2.jpg';
const commission = { type:'commission', source_label:'每日委托',version:'5.0', cover_path:NATLAN_ART,cover_source_url:'https://www.hoyolab.com/article/33468034',cover_focus:{x:.5,y:.42} };
/** Curated corrections use source IDs. Never merge independent source tasks or edit source databases. */
export const CHAPTER_CORRECTIONS:Record<number,KnownChapter> = {
  25029:{...commission,variant_label:'初次相遇 · 向山顶出发'},
  25033:{...commission,variant_label:'攀登训练 · 继续挑战'},
  25034:{...commission,variant_label:'遭遇盗贼 · 保护奇卡'},
  318:{type:'tutorial',source_label:'教学任务',version:''},
  467:{type:'tutorial',source_label:'教学任务',version:'1.0'},
  469:{type:'tutorial',source_label:'教学任务',version:'1.0'},
  470:{type:'tutorial',source_label:'教学任务',version:'1.0'},
  21004:{type:'wq',source_label:'世界任务',version:'1.0',variant_label:'其二 · 调查遗迹'},
  21022:{type:'wq',source_label:'世界任务',version:'1.0',variant_label:'其一 · 寻找石碑'},
  73294:{type:'wq',source_label:'世界任务',version:'3.6',variant_label:'第一段 · 初遇画家'},
  73295:{type:'wq',source_label:'世界任务',version:'3.6',variant_label:'第二段 · 重返营地'},
  73296:{type:'wq',source_label:'世界任务',version:'3.6',variant_label:'第三段 · 再访画家'},
};
const LABELS:Record<string,string>={aq:'魔神任务',lq:'传说任务',wq:'世界任务',eq:'活动任务',voice:'角色语音',other:'其他任务',commission:'每日委托',tutorial:'教学任务'};
export function normalizeChapter(row:ChapterRow):Chapter {
  const correction=CHAPTER_CORRECTIONS[row.id];
  const type=correction?.type??(row.type==='iq'?'other':row.type);
  const version=correction?.version??(row.type==='iq'||!/^(?:\d+(?:\.\d+)?|Luna [IVXLCDM]+)$/i.test(row.version)?'':row.version);
  const discardVersionCover=!correction?.cover_path&&!version&&row.cover_match==='inherited_version_key_art';
  return {...row,original_type:row.type,original_version:row.version,type,version,source_label:LABELS[type]||row.source_label||type,...correction,
    ...(discardVersionCover?{cover_path:null,cover_source_url:null,cover_match:null}:{}),
    ...(correction?.cover_path?{cover_match:'official_region_key_art_verified'}:{})};
}
interface Catalog {entries:Chapter[];byId:Map<number,Chapter>}
let cachedDb:Database.Database|null=null;
let cachedCatalog:Catalog|null=null;
export function clearChapterCatalog(){cachedDb=null;cachedCatalog=null;}
export function chapterCatalog(db:Database.Database):Catalog {
  if(cachedDb===db&&cachedCatalog)return cachedCatalog;
  const rows=db.prepare('SELECT * FROM chapters ORDER BY sort_order,id').all() as ChapterRow[];
  const counts=new Map((db.prepare('SELECT q.chapter_id,COUNT(*) n FROM dialog_lines d JOIN quests q ON q.id=d.quest_id GROUP BY q.chapter_id').all() as {chapter_id:number;n:number}[]).map(row=>[row.chapter_id,row.n]));
  const entries=rows.map(row=>({...normalizeChapter(row),dialogue_count:counts.get(row.id)||0}));
  const groups=new Map<string,Chapter[]>();
  for(const row of entries){const title=(row.title_chs||row.title_en).trim();if(!title)continue;const group=groups.get(title)||[];group.push(row);groups.set(title,group);}
  for(const group of groups.values()){
    if(group.length<2)continue;
    const hashes=new Map<string,Chapter[]>();
    for(const [index,row] of group.entries()){
      row.variant_count=group.length;
      row.variant_label??='同名台本 '+(index+1)+' / '+group.length+' · '+row.dialogue_count+' 句';
      if(!row.dialogue_count)continue;
      const text=db.prepare("SELECT coalesce(d.speaker,'')||char(9)||coalesce(d.text_en,'')||char(9)||coalesce(d.text_chs,'') AS text FROM dialog_lines d JOIN quests q ON q.id=d.quest_id WHERE q.chapter_id=? ORDER BY q.sort_order,q.id,d.sort_order,d.id").all(row.id) as {text:string}[];
      const hash=createHash('sha256').update(text.map(item=>item.text).join('\n')).digest('hex');
      const same=hashes.get(hash)||[];same.push(row);hashes.set(hash,same);
    }
    for(const same of hashes.values())if(same.length>1)for(const row of same)row.duplicate_text_count=same.length;
  }
  cachedDb=db;cachedCatalog={entries,byId:new Map(entries.map(row=>[row.id,row]))};return cachedCatalog;
}
export function browsableChapters(db:Database.Database) {
  return chapterCatalog(db).entries.filter(row=>!(row.title_chs+' '+row.title_en).includes('$HIDDEN')&&!/^\s*\(?test\)?/i.test(row.title_chs+' '+row.title_en));
}
