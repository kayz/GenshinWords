import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ReadingDefinition } from './reading-bank-types';
import type { ReadingPaperDefinition, PaperPassageDefinition, IndependentReadingDefinition } from './reading-paper-types';
import type { ReadingPassage } from '../shared/reading';
import { annotateReadingParagraphs } from '../shared/reading-text';

export function readingPassageTitle(title: string): string {
  let clean = title.trim(), previous: string;
  do {
    previous = clean;
    clean = clean.replace(/^(?:Section\s+[A-Z]|Passage\s+(?:One|Two|Three|Four|Five|\d+)|Part\s+[A-Z0-9]+|[A-Z]|第[一二三四五六七八九十\d]+篇)\s*[·:：.\-]\s*/i, '').trim();
  } while (clean !== previous);
  return clean || title;
}

/** Author collections remain available for historical IDs; each selected passage is its own practice. */
export function composeReadingPassage(group: ReadingPaperDefinition, passage: PaperPassageDefinition): ReadingDefinition {
  const title = readingPassageTitle(passage.title);
  const unit = composeReadingPaper({
    ...group, id: passage.id, title,
    background: '和派蒙一起读懂这个片段，再试试本篇的小练习吧。',
    passages: [{ ...passage, title }],
  });
  return { ...unit, kind: 'single', sourceTitle: passage.sourceTitle, estimatedMinutes: undefined, practiceType: passage.type };
}

function remapParagraphReferences(value:string,map:Map<number,number>,passageId:string):string {
  return value.replace(/\bP([1-9]\d*)\b/g,(_match,number)=>{
    const global=map.get(Number(number));
    if(global===undefined)throw new Error('讲解文字引用未选段：'+passageId+' P'+number);
    return 'P'+global;
  });
}

export function paperSections(paper: ReadingPaperDefinition, visibleParagraphs?:string[]): ReadingPassage[] {
  let offset = 0;
  return paper.passages.map(p => {
    const global = (n: number) => {
      const index = p.paragraphMap.findIndex(pair => pair.en === n);
      if (index < 0) throw new Error(`${paper.id}/${p.id} 引用了未选取的源段 P${n}`);
      return offset + index + 1;
    };
    const section: ReadingPassage = {
      id: p.id, title: p.title, type: p.type, instructions: p.instructions,
      sourceTitle: p.sourceTitle, sourceUrl: p.sourceUrl, coverPath: p.coverPath, coverFocus: p.coverFocus,
      paragraphIndices: p.paragraphMap.map(pair => global(pair.en)), questionIds: p.questions.map(q => q.id),
      optionPool: p.optionPool,
      paragraphLabels: p.paragraphLabels?.map(label => ({label: label.label, paragraphs: label.paragraphs.map(global)})),
    };
    if(visibleParagraphs&&(paper.level==='entry'||paper.level==='sh_zhongkao')){
      const targets=[...(p.masks??[]).map(mask=>mask.expectedText),
        ...p.questions.filter(question=>question.type==='fill').flatMap(question=>[question.expected,...(question.accepted??[])])];
      section.glossary=p.glossary.filter(entry=>entry.kind==='word'
        &&!annotateReadingParagraphs(targets,[entry]).some(parts=>parts.some(part=>part.note))
        &&annotateReadingParagraphs(section.paragraphIndices.map(n=>visibleParagraphs[n-1]),[entry]).some(parts=>parts.some(part=>part.note)));
    }
    offset += p.paragraphMap.length;
    return section;
  });
}

export function composeReadingPaper(paper: ReadingPaperDefinition): ReadingDefinition {
  if (!paper.passages.length || new Set(paper.passages.map(p=>p.id)).size !== paper.passages.length) throw new Error('整卷篇目编号无效：'+paper.id);
  const first = paper.passages[0], sections = paperSections(paper);
  const questions = paper.passages.flatMap((p,index) => {
    if(p.optionPool && (new Set(p.optionPool.map(option=>option.id)).size!==p.optionPool.length || p.optionPool.some(option=>!option.id||!option.text)))
      throw new Error('共享选项池编号无效：'+p.id);
    if(p.paragraphLabels){
      const labelled=p.paragraphLabels.flatMap(group=>group.paragraphs);
      if(new Set(p.paragraphLabels.map(group=>group.label)).size!==p.paragraphLabels.length || new Set(labelled).size!==labelled.length || p.paragraphLabels.some(group=>!group.label||!group.paragraphs.length))
        throw new Error('匹配题段落分组无效：'+p.id);
      if(p.type==='matching'&&(labelled.length!==p.paragraphMap.length||p.paragraphMap.some(pair=>!labelled.includes(pair.en))))
        throw new Error('匹配题必须为每个原文段指定自然段组：'+p.id);
    }
    const map = new Map(p.paragraphMap.map((pair,i)=>[pair.en,sections[index].paragraphIndices[i]]));
    if(p.type==='matching'&&!p.paragraphLabels?.length)throw new Error('段落匹配题缺少自然段分组：'+p.id);
    return p.questions.map(q => ({...q,prompt:remapParagraphReferences(q.prompt,map,p.id),hint:remapParagraphReferences(q.hint,map,p.id), passageId:p.id, pooled:Boolean(p.optionPool)||p.type==='matching',
      options:q.options ?? (q.type==='choice' ? p.optionPool : undefined),
      solution:{...q.solution,explanation:remapParagraphReferences(q.solution.explanation,map,p.id),
        optionExplanations:q.solution.optionExplanations?.map(option=>({...option,text:remapParagraphReferences(option.text,map,p.id)})),evidence:q.solution.evidence.map(n=>{
        if(!map.has(n))throw new Error('题目证据超出选段：'+q.id+' P'+n);return map.get(n)!;
      })},
    }));
  });
  if(new Set(questions.map(q=>q.id)).size!==questions.length)throw new Error('同一卷含重复题号：'+paper.id);
  for(const q of questions){
    if(!q.id||q.solution.questionId!==q.id||!q.expected||q.type==='choice'&&(!q.options?.some(option=>option.id===q.expected)||new Set(q.options.map(option=>option.id)).size!==q.options.length))
      throw new Error('套卷题目或标准答案配置无效：'+q.id);
    if(q.type==='choice'&&q.solution.answerId&&q.solution.answerId!==q.expected)throw new Error('答案解析与判分选项不一致：'+q.id);
  }
  const structure = [], sentences = [];
  paper.passages.forEach((p,index)=>{
    const global=(n:number)=>{const i=p.paragraphMap.findIndex(pair=>pair.en===n);if(i<0)throw Error('讲解引用未选段：'+p.id);return sections[index].paragraphIndices[i];};
    const map=new Map(p.paragraphMap.map(pair=>[pair.en,global(pair.en)]));
    structure.push(...p.analysis.structure.map(s=>({...s,description:p.title+'：'+remapParagraphReferences(s.description,map,p.id),paragraphs:s.paragraphs.map(global)})));
    sentences.push(...p.analysis.sentences.map(s=>({...s,explanation:remapParagraphReferences(s.explanation,map,p.id),paragraph:global(s.paragraph)})));
  });
  return {id:paper.id,title:paper.title,level:paper.level,background:paper.background,kind:'paper',paper,
    estimatedMinutes:paper.estimatedMinutes,materialId:first.materialId,textSha256:first.textSha256,chsTextSha256:first.chsTextSha256,
    bilingualAlignmentVerified:true,wordCount:0,paragraphCount:sections.reduce((n,s)=>n+s.paragraphIndices.length,0),
    sourceTitle:paper.title,sourceUrl:first.sourceUrl,coverPath:first.coverPath,coverFocus:first.coverFocus,
    questions,glossary:paper.passages.flatMap(p=>p.glossary),analysisGlossary:paper.passages.flatMap(p=>p.analysisGlossary??[]),
    analysis:{overview:paper.passages.map((p,index)=>p.title+'：'+remapParagraphReferences(p.analysis.overview,new Map(p.paragraphMap.map((pair,i)=>[pair.en,sections[index].paragraphIndices[i]])),p.id)).join('\n\n'),structure,sentences}};
}

export function loadPaperParagraphs(db: Database.Database, unit: ReadingDefinition) {
  const paper=unit.paper!, en:string[]=[], chs:string[]=[], masked:string[]=[];
  const query=db.prepare('SELECT text,paragraphs_json FROM texts WHERE material_id=? AND locale=?');
  const selected=new Set<string>();
  for(const p of paper.passages){
    if(!p.bilingualAlignmentVerified)throw Error('双语配对未经核对：'+p.id);
    const locales={} as Record<'en'|'chs',string[]>;
    for(const locale of ['en','chs'] as const){
      const row=query.get(p.materialId,locale) as {text:string;paragraphs_json:string}|undefined;
      if(!row||createHash('sha256').update(row.text,'utf8').digest('hex')!==(locale==='en'?p.textSha256:p.chsTextSha256))throw Error('套卷原文版本不匹配：'+p.id+' '+locale);
      const parts=JSON.parse(row.paragraphs_json);
      if(!Array.isArray(parts)||parts.some((part,i)=>part.order!==i||typeof part.text!=='string'))throw Error('套卷源段无效：'+p.id);
      const originalLines=row.text.split('\n').filter(line=>line.trim());
      if(parts.length!==originalLines.length||parts.some((part,i)=>part.text!==originalLines[i]))throw Error('套卷源段与校验原文不一致：'+p.id);
      locales[locale]=parts.map(part=>part.text);
    }
    let previous=0;
    for(const pair of p.paragraphMap){
      if(!Number.isSafeInteger(pair.en)||pair.en<=previous||!locales.en[pair.en-1]||!pair.chs.length||pair.chs.some((n,i)=>!Number.isSafeInteger(n)||n<1||!locales.chs[n-1]||(i>0&&n<=pair.chs[i-1])))throw Error('套卷英中源段映射无效：'+p.id);
      previous=pair.en;
      const key=p.materialId+':'+pair.en;if(selected.has(key))throw Error('同卷重复展示相同原文可能泄露答案：'+p.id);selected.add(key);
      const original=locales.en[pair.en-1];
      const masks=(p.masks??[]).filter(m=>m.paragraph===pair.en).sort((a,b)=>a.start-b.start);
      for(let i=0;i<masks.length;i++){
        const m=masks[i];
        if(!Number.isSafeInteger(m.start)||!Number.isSafeInteger(m.end)||m.start<0||m.end<=m.start||m.end>original.length||original.slice(m.start,m.end)!==m.expectedText||(i>0&&m.start<masks[i-1].end)||!p.questions.some(q=>q.id===m.questionId))throw Error('套卷挖空偏移不符原文：'+p.id+' '+m.questionId);
        const question=unit.questions.find(q=>q.id===m.questionId)!;
        const normalize=(value:string)=>value.normalize('NFKC').replace(/[’‘]/g,"'").trim().replace(/\s+/g,' ').toLowerCase();
        const accepted=question.type==='choice'?[question.options!.find(option=>option.id===question.expected)!.text]:[question.expected,...(question.accepted??[])];
        if(!accepted.some(answer=>normalize(answer)===normalize(m.expectedText)))throw new Error('挖空原文与题目标准答案不一致：'+m.questionId);
      }
      let visible=original;
      for(const m of [...masks].reverse()){
        const question=unit.questions.find(q=>q.id===m.questionId)!;
        const number=unit.questions.indexOf(question)+1;
        visible=visible.slice(0,m.start)+`[${number}] ${question.firstLetter??''}________`+visible.slice(m.end);
      }
      en.push(original);chs.push(pair.chs.map(n=>locales.chs[n-1]).join('\n'));masked.push(visible);
    }
    for(const mask of p.masks??[])if(!p.paragraphMap.some(pair=>pair.en===mask.paragraph))throw Error('挖空在未选段内：'+p.id);
    if(['cloze','initial-fill','word-bank','sentence-gap'].includes(p.type)&&p.questions.some(q=>p.masks?.filter(m=>m.questionId===q.id).length!==1))throw Error('每道挖空题必须且只能有一个正文空位：'+p.id);
  }
  return {en,chs,masked};
}

/** Use the verified source and masking pipeline for one standalone reading. */
export function composeIndependentReading(reading: IndependentReadingDefinition): ReadingDefinition {
  const { level, estimatedMinutes, ...passage } = reading;
  const unit = composeReadingPassage({ id: passage.id, title: passage.title, level,
    background: '和派蒙一起读读这段故事吧。', estimatedMinutes: estimatedMinutes ?? 0, passages: [passage] }, passage);
  return { ...unit, estimatedMinutes };
}
