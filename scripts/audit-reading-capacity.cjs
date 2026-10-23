/* Read-only snapshot audit. Produces project screening candidates, never approved exam levels. */
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Database=require('better-sqlite3');
const root=path.resolve(__dirname,'..'), content=path.join(root,'content');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const normalize=value=>String(value??'').normalize('NFKC').replace(/[’‘]/g,"'").replace(/[‐‑–—]/g,'-').replace(/\s+/g,' ').trim().toLowerCase();
const tokens=text=>[...text.matchAll(/[A-Za-z]+(?:['’‘-][A-Za-z]+)*/g)].map(match=>normalize(match[0]));
const levels=[
  {id:'entry',label:'初中基础',min:55,max:180,coverage:.88,average:18,longest:40,sentences:3,rank:0},
  {id:'sh_zhongkao',label:'上海中考',min:100,max:400,coverage:.85,average:22,longest:50,sentences:4,rank:0},
  {id:'sh_gaokao',label:'上海高考',min:180,max:700,coverage:.87,average:28,longest:65,sentences:5,rank:1},
  {id:'cet4',label:'CET4',min:200,max:800,coverage:.88,average:30,longest:75,sentences:5,rank:2},
  {id:'cet6',label:'CET6',min:300,max:800,coverage:.88,average:36,longest:100,sentences:6,rank:3},
];
const round=n=>Math.round(n*10000)/10000;
const countBy=(rows,key)=>Object.fromEntries([...new Set(rows.map(key))].sort().map(value=>[value,rows.filter(row=>key(row)===value).length]));
// English was read in full for these 25 candidates; Chinese was read in full
// for entry and sampled at the beginning/end elsewhere. This is not paragraph alignment approval.
const sampleReviews=[
  ['entry','character-story:10000020:1','可优先审核','狼群生活与身世对照明确；Lupical在原文已有定义。适合少量事实题，不把五段机械拆成五篇。'],
  ['entry','character-story:10000050:2','可优先审核','投喂流浪动物的动机自洽；scarf down等表达需解释，不能只凭词表判断已熟悉。'],
  ['entry','character-story:10000048:4','建议升档复核','烟绯对问候语的层层误读涉及反讽与语用推理，postulate、whence等也偏难；短且覆盖高仍不等于初中基础可用。'],
  ['entry','character-story:10000020:2','需检查信息重复','生活描写可独立阅读；与雷泽故事1主题和若干事实近似，应避免两篇重复考人与狼的关系。'],
  ['entry','character-story:10000014:3','需限制设问范围','能考人物比较与情绪，但结尾提出的问题未解决；不可据此问她后来如何获得成功。'],
  ['sh_zhongkao','character-story:10000140:2','可优先审核','家庭合唱与循序渐进主题有完整落点；专名较多，合唱隐喻较密，应复核负担或选取完整段落。'],
  ['sh_zhongkao','character-story:10000125:7','需补背景','三月权能、家与支配的对比可命题；桑多涅、博士和三位姐姐依赖设定，不能让答案依赖未给出的剧情。'],
  ['sh_zhongkao','character-story:10000025:2','可优先审核','哥哥误解与真实武侠书形成叙事反差；推断必须有文本依据，不能扩写哥哥未明说的书籍类型。'],
  ['sh_zhongkao','character-story:10000070:3','可优先审核','看舞蹈到受邀请的事件链完整，适合顺序、细节和人物感受；先核专名负担。'],
  ['sh_zhongkao','character-story:10000044:5','需讲解修辞','成见、种子比喻和storm in a teacup能构成题点；抽象论述比同词数事件故事难。'],
  ['sh_gaokao','character-story:10000092:6','需中译展示复核','书信与结尾含蓄抒情可命题；官方中文主体是粤语，不能称为普通话译文，也不应私自改写官方来源。'],
  ['sh_gaokao','character-story:10000102:1','可优先审核','海滩、店铺与交友主题形成完整人物画像；连续场景能支持独立题点，折扣信息不能重复出多道同答案题。'],
  ['sh_gaokao','character-story:10000068:7','需角色提示','姐妹、药方与动机链条在文中成立；前文不点主人公姓名，题名或短背景需交代指代，神之眼设定不应成为隐藏考点。'],
  ['sh_gaokao','character-story:10000133:2','需角色提示','照料阿兰到练习生活有完整转折；她的身份需清楚标注，不假定读过上一则故事。'],
  ['sh_gaokao','character-story:10000133:3','需补背景','家与被需要的反思可命题；她、阿兰与普隆尼亚的关系承接前篇，不宜直接当无背景独立短篇。'],
  ['cet4','character-story:10000133:1','需按题型选段','从诞生到重新认识父亲的线索完整；757词超过四级单篇细读常见长度，全文训练可行但不是已校准真题篇幅。'],
  ['cet4','character-story:10000131:2','需控制术语负担','求知、引导与内心独白可区分题点；含流体/轨道/热力学词，篇末并未给物理答案，不能据此考公式知识。'],
  ['cet4','character-story:10000130:2','需前情提示','换生灵身份与家庭变化构成事件链；开头承接旧书线索，需说明其存在而不能补写未给事实。'],
  ['cet4','character-story:10000123:4','需设定与篇幅复核','母亲告别的叙事可读；希穆兰卡与三位创造者的设定密，737词不等于四级标准细读。'],
  ['cet4','character-story:10000086:7','需设定与篇幅复核','隐藏与公开佩戴神之眼形成结构照应；堡垒、审判官与爵位需背景，不能依赖游戏常识判分。'],
  ['cet6','character-story:10000106:2','可优先审核','解谜习惯、加限制与商业误用构成多层因果，适合主旨、限制条件和态度题。'],
  ['cet6','character-story:10000091:5','需补背景','灾后悲伤与水循环修辞可分析；预言、衣物遗留的意义依赖前情，未说明部分不能成为正确答案。'],
  ['cet6','character-story:10000025:7','需分文体处理','前半门派解释与后半诗体歌诀难度不同；古典修辞不代表六级学术覆盖，可先审核叙述段并保留原句。'],
  ['cet6','character-story:10000128:0','可优先审核','酒馆传说与普通出身互相反驳，适合观点、证据和叙事功能；古语仍需复核。'],
  ['cet6','character-story:10000080:6','需说明虚构技术','装置结构、工作步骤与使用限制可命题；是幻想装置说明，不能当真实测绘技术教材。'],
].map(([level,id,status,notes])=>({level,id,status,notes,englishReview:'full-text',chineseReview:level==='entry'?'full-text':'beginning-and-ending-sample',bilingualAlignmentApproved:false}));
const boundaryReviews=[
  {id:'book:1:100189:8',finding:'连载卷二开头承接狐狸被困、结尾悬念转至下一卷；结构无占位不代表独立故事。可选段审核，不按11卷自动得到11份完整练习。'},
  {id:'book:100352:100352:43',finding:'杜拉夫的信88词但没有说明真相内容；只能考信内明确的建议与计划，不能问提米父亲发生了什么。'},
  {id:'book:100616:100616:165',finding:'与book:1019:100580:145正文精确重复，标题不同。只算一份来源，体裁应读正文核实，不能把百货标题自动当应用文。'},
  {id:'voice:10000002:34',finding:'绫华87词回忆含叹息与口语，文字完整但独立信息量有限；可作微阅读候选，不能假定稳定产出三道互不重复的题。'},
  {id:'companion:368117:6902903:0',finding:'可莉预览看似连续，实际图有26节点、3处分叉；必须先审查选项、条件和中英相同路径，现阶段不进主候选。'},
];
const reviewedSourceHashes={
  "character-story:10000020:1": {
    "chs": "ea25d250e11cec36f6267b3b89409bdc56a83ea6fd974e36cd268941e2599484",
    "en": "92b07942f416eb2dda5cc21439aadd1e0db963896f558b2537c1f064e83c8df5"
  },
  "character-story:10000050:2": {
    "chs": "d8f58ee60557f6d33caec379452132a651c522dc29a3c87d8c0bd32a27db7448",
    "en": "820988527265add7e1454ba4feaa4a3beb9f807bdb1ea80cb0127cc482e18ec7"
  },
  "character-story:10000048:4": {
    "chs": "f5ec19ea506adc9fcce07d55f70690cb27c6cb1946d66911fcd9ab9db1992b90",
    "en": "46c31bca49e5e0006e375eeff40350b0bfa61a541b3dddfdc28beaafd20f82e7"
  },
  "character-story:10000020:2": {
    "chs": "ef1165f7ef333c5fe6852bd13b98283af6c96a9dd5e55692732756943d4ee875",
    "en": "0e157fa012cb3968bde446ebcbb78dd907c2c0fa5e14cb60c3b944fdf400c3f9"
  },
  "character-story:10000014:3": {
    "chs": "e810034cf9b19bcd63c114730f39b4005c3e939d1b2a507e9ea6da74e5d5de94",
    "en": "3d723d535d601d2bdb64679866f2565c131caa3b6118fbb4ecb0fb8182d175bb"
  },
  "character-story:10000140:2": {
    "chs": "182f64a952817eb25083b4217cf899ad00609d4ee4e20337403374a5876501fe",
    "en": "88b6b7ce71269c260d1bc542eb55f11a7f6bb2fc8be4015e93aa1f484f898cc0"
  },
  "character-story:10000125:7": {
    "chs": "d114155e1093ea5f2fd83053daac3587e05606570b552c8acefd948112ebec4b",
    "en": "3df8debe1d93dc177243e2525154d5de93861b13eaacc473d3360cb0dbc18690"
  },
  "character-story:10000025:2": {
    "chs": "f4b68852e5d42a9a6e52cc3894841174cc75b3a410dc865269fabe673c010c32",
    "en": "7c28a3c02ecdea5adf5fae9aa3ea9aa7ea032e82cadf7ab819ff4e134f3846e9"
  },
  "character-story:10000070:3": {
    "chs": "31e67590b1b2d819085c9281b394fd94c7a74054d60026c6997d262a294c341c",
    "en": "f9829e403c214edf75b03695b8de7cd95757417394731ba538f655dd52d577c3"
  },
  "character-story:10000044:5": {
    "chs": "ef0bcff11db656cd6e494a62112baeda35701e3bf8cf70c0fabae382500e43bd",
    "en": "99eb977459e339735ee87db26d3ad9ff40993fdb1d8a59a60b03b4d2a31f7198"
  },
  "character-story:10000092:6": {
    "chs": "9090ad8e050272caeb493c8f43c9ec21119da9190e47953ceb95dd00f44f3430",
    "en": "c7228b713a67ea09bfad16502b3a58ee38e89f9783e70bcd4d30831b3216ab3c"
  },
  "character-story:10000102:1": {
    "chs": "128c5f6d22edce94cf52968f59bc963529a081f613adbc0ab780b81e2407a302",
    "en": "9a13998c38362266464e59ec8dc7441586e3d6c61b085bce2dc8085ce6f5c367"
  },
  "character-story:10000068:7": {
    "chs": "dbdf38ebcdacfbf2c81a6efdb3e2d83f7f96d3e495b559d170a5b3b0cd46eb66",
    "en": "8cd958383813c05fef1b846eb759ea6d46c1cd083a93cb573116111b42c8d5f4"
  },
  "character-story:10000133:2": {
    "chs": "614d175ccde5df4305c512cd89087ddf326ea0c773e51c425fd0a9b995fed8c5",
    "en": "28fbf9a812484eea74aef937dbeff82edf0953dce091db92a894676ef05850db"
  },
  "character-story:10000133:3": {
    "chs": "581e7c3934d9be2fc63410fdd4acf7beb58157fe9e2f9195d4b2b0a2542fd3e8",
    "en": "74d1bbecb66a2c24572f626de3f617167474cdc13eaa1761f9e841975fb1bb5d"
  },
  "character-story:10000133:1": {
    "chs": "8eed693e404080633b270726dbf55afd8d591073679688ef8fc77dea93b656dc",
    "en": "8fdc0da4488f148653a14e873b99876ec1432bc1419057e2369958f432ff3740"
  },
  "character-story:10000131:2": {
    "chs": "26f9012126e93814d0a4864a486b2ecae40119bceba93b8a7af3036a6a9fc706",
    "en": "dfac064444eb9ef031855ef87def3905816e99fd98940ba65e12248e650b8dbb"
  },
  "character-story:10000130:2": {
    "chs": "9d08a02a6e1ef2a7615b6f08c29affe6ece20e8e20bb9975c1d8607c44738f81",
    "en": "b91b9a0af12f546683ea89987595177b59b2572836538a2c64f514765320b9b9"
  },
  "character-story:10000123:4": {
    "chs": "6bc2e82f8262c339d70828359d4c112914f93ef32aabd3a01f015db37932b5da",
    "en": "5d17ee668f7807935d5626a6906de2fee4e7b20ea573d24d5f6cedd1ca8dd63e"
  },
  "character-story:10000086:7": {
    "chs": "6c44be566f31b2f01b4f7d8d60615b23ad9552f44727f89010ff24eb1cc5914a",
    "en": "979c9d6437c53f11fe114c5cf089714127c9b486d4779b042f76250fa42a1905"
  },
  "character-story:10000106:2": {
    "chs": "43526725872c9c9f386dd7b9363dc6ff31f7e2f9a8efd3bb312ee481a6892215",
    "en": "8673a3c2abb17a38b868421bdd3b97ad295d0c73194a991cb1f8924e37e74387"
  },
  "character-story:10000091:5": {
    "chs": "4c3bcebd8a7abbc4f1e2fa8845c57e853b2e57c2510c31b268f18fab5de27cdc",
    "en": "8198e3e3e2c12a12c5f90a42e061937f155fc9f49b0dc6bd9d3a2b03c74dae44"
  },
  "character-story:10000025:7": {
    "chs": "d6ecb0a19d79ecd04625f266d124c0e1b9d3d04b9708f663a863316884ce814a",
    "en": "b55ee4810ec49e51ea09929648c013167de0cffe018f5c6114f74bdc1ecd681b"
  },
  "character-story:10000128:0": {
    "chs": "ec95efeebc185ca31ec9afd7dfc4b422e4f4dc52889c58a04ae87711df312949",
    "en": "366869ac8037995724da6382053b1316ca516c212538cb4c9fec306fdbbb7423"
  },
  "character-story:10000080:6": {
    "chs": "c49ea57d201aaa6bd49d117141061c2d4fa200bbfdb36b8ba81cffc37dd6610f",
    "en": "d8e6b64a83070123f854db2a33089a0571190d098e9b75dcb678bd5bb788f91c"
  },
  "book:1:100189:8": {
    "chs": "dd24e83be85b54be055a617e753a31c31820883e66a1863a0b7e18ba03c5731f",
    "en": "9bc2a495b6b351ca05e934803690f7fbfced6a3c1d1179b407de062093b2e2d4"
  },
  "book:100352:100352:43": {
    "chs": "3bbc1e3415473503ed9008c291c46dd76511c749798bcae2263f78d497961af3",
    "en": "05f9a5d6b840c792071a2605c63d8e0da4647dcd33708ede7153798b257c7de3"
  },
  "book:100616:100616:165": {
    "chs": "de1ae05febebd9955ded454a26543ca513be5affb47761d60b924c11c0fca409",
    "en": "46bf126508e455a5b5a9be51d0e02a8fd758a521cdeb2062aa68a27c1ca81593"
  },
  "voice:10000002:34": {
    "chs": "e2c602cefe7d1864b1876793484611a45bde2f949323de4bca815741ef01c068",
    "en": "7b8453eb8a37393606c29d2b346cac11a32d0e0d59d9c45222dcb8be7341a351"
  },
  "companion:368117:6902903:0": {
    "chs": "9f53d097599b21633fca5cb69d8984c61fb8268f17de6ec8bd28e51b51c12ed5",
    "en": "80c18fcdd37ed518a2430937e5c13fd1268070f5b8e99e86e0a9ab8aae371651"
  }
};
let packagedReadingInventory;
function readyDefinitions(){
  // Decode pure author data; never initialize runtime storage or open personal progress.
  const core=require('./reading-package-loader.cjs').loadReadingPackageCore();
  packagedReadingInventory=core.decodeReadingPackage(fs.readFileSync(path.join(content,'reading/base.gwreading')));
  return packagedReadingInventory.units.flatMap(unit=>unit.paper
    ?unit.paper.passages.map(p=>({...unit,...p,level:unit.level,exerciseId:unit.id}))
    :[{...unit,exerciseId:unit.id}]);
}
async function fileHash(file){
  const digest=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(file))digest.update(chunk);
  return digest.digest('hex');
}
function imageExists(relative){
  const safe=String(relative??'').replaceAll('\\','/').replace(/^images\//,'');
  if(!safe||safe.split('/').includes('..')||path.isAbsolute(safe))return false;
  return Boolean(packagedReadingInventory?.data.images.some(image=>image.path===safe))||fs.existsSync(path.join(content,'images',safe));
}
function structuralProblems(en,chs){
  const result=[];
  if(!en?.text.trim())result.push('empty_english');
  if(!chs?.text.trim()||!/[\u3400-\u9fff]/u.test(chs.text))result.push('missing_chinese');
  for(const [locale,row] of [['en',en],['chs',chs]])if(row){
    if(/\{[^{}]*\}/u.test(row.text)||/(?:^|\n)\s*#/u.test(row.text))result.push('unresolved_control_'+locale);
    try{const parts=JSON.parse(row.paragraphs_json), lines=row.text.split('\n').filter(line=>line.trim());
      if(parts.length!==lines.length||parts.some((p,i)=>p.order!==i||p.text!==lines[i]))result.push('paragraph_mismatch_'+locale);
    }catch{result.push('invalid_paragraphs_'+locale);}
  }
  return result;
}
function riskFlags(text,title){
  const risks=[];
  if(/^(?:but|and|so|however|meanwhile|then|therefore|besides)\b/i.test(text.trim()))risks.push('opening_needs_context');
  if(/^["“']?(?:he|she|they|his|her|their)\b/i.test(text.trim()))risks.push('opening_pronoun_needs_subject_label');
  if(!/[.!?…]["'”’\)\]]*\s*$/u.test(text.trim()))risks.push('ending_needs_review');
  if(/(?:to be continued|continued from|previous (?:chapter|volume)|the following chapter)/i.test(text))risks.push('serial_dependency');
  if(/\([IVXLCDM]+\)|\b(?:part|vol(?:ume)?)[ .]*\d/i.test(title))risks.push('serial_volume');
  return risks;
}
function fit(metrics,level,long=false){return metrics.words>=level.min&&(long||metrics.words<=level.max)&&metrics.coverage[level.id]>=level.coverage&&metrics.averageSentence<=level.average&&metrics.longestSentence<=level.longest&&metrics.sentences>=level.sentences;}
function markdown(report){
 const s=report.summary;
 const levelRows=report.rules;
 const line=(r,l)=>`| ${l.label} | ${r.readyExercises} | ${r.primary} | ${r.newPrimary} | ${r.newPrimaryWithImage} | ${r.newPrimaryWithoutImage} | ${r.crossSupport} | ${r.longSources} |`;
 return `# 本地阅读资料容量审计

## 结论口径

本报告只盘点当前本地快照，未获取新资料。每篇独立学习、提交和判分。**自动筛选数是待审核文本候选，不是已能直接上线的练习量，也不是正式考试等级或承诺产量。** 每份来源仍须核查独立性、题点数量、中译配对和设问歧义。

现成已编写 **${s.ready.exercises}篇练习，来自${s.ready.sourceMaterials}份不同材料，共${s.ready.questions}题**。同一材料在不同档位或题型下复用不计为新增来源。

| 档位 | 现成练习 | 互斥静态短篇候选 | 其中新增来源 | 新增且有已关联题图 | 新增待关联题图 | 跨档支持总数（不可相加） | 另有长来源需选段审核 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${levelRows.map(l=>line(s.levels[l.id],l)).join('\n')}

互斥主档按初中基础→上海中考→上海高考→CET4→CET6归档，优先上海中学生。总候选${s.static.primary}份，新增${s.static.newPrimary}份；其中${s.static.primaryWithRisk}份已有自动风险标记，其余也没有通过人工独立性审核。**不能把互斥CET4的${s.levels.cet4.primary}份与高考的${s.levels.sh_gaokao.primary}份解读为两类资料真实比例**：高考门槛命中者优先归高考，超过其700词上限者才可能进入CET4主档。跨档列保留覆盖重叠，禁止跨档加总。

长来源共${s.static.long}份。长来源列只表示完整来源的词表／句长预筛命中，放宽了篇幅上限，**不表示可在该档整篇使用，也不表示已有可用选段或符合四六级长篇匹配**。每来源只计一次，选段潜力没有按滑动窗口倍乘。基础档的长来源同样必须重新挑选自洽段落。

## 来源、去重与排除

- 原始材料${s.rawMaterials}条；非空英文${s.nonemptyEnglish}条；按规范化英文SHA256去重后${s.distinctEnglish}份，合并${s.duplicateRows}条重复。规范化为NFKC、大小写、弯引号／横线和空白，不用标题或中文误合并不同英文。
- 静态书籍／人物资料原始${s.static.raw}条，非空英文去重后${s.static.distinctNonempty}份。原始类别：${JSON.stringify(s.rawByKind)}。
- 任务／尘歌壶／旁白原始${s.tasks.raw}条，非空预览去重${s.tasks.distinctPreviews}份，**全部单列待路径、条件与中英分支审核**。至少${s.tasks.branchingGraphs}个图存在分叉。首分支preview、节点、选项不是完整篇；旁白顺序也不证明情境齐备。现成烹饪对话只代表其已选路径核对完成，不能推广到其他任务。
- 语音原始${s.voices.raw}条、非空去重${s.voices.distinct}份；${s.voices.screened}份达到文本长度／词表筛选条件，作为**需补情境及信息量复核的辅助池**。语音不进入静态短篇主数量，不假定47词能稳定出三道不同题。
- 结构问题：${JSON.stringify(s.issues)}。同一记录可有多个问题，不能相加。排除空／无汉字中译、未解析控制占位、段落保真异常，以及不满足当前筛选参数者。未入主候选不等于永久无教学价值。

任务／语音分池按各自来源身份统计，极少量跨类别相同正文可以在池间重叠；全语料去重总数只计一次。JSON记录完整任务待审核清单、语音候选及静态排除原因。

## 可重跑与证据

运行 \`node scripts/audit-reading-capacity.cjs\`，生成本文件和[完整候选JSON](reading-capacity.json)。三个SQLite均readonly加query_only；没有读取个人进度库或修改资料、词库、题目和图片。现成数量从content/reading/base.gwreading的纯数据读取并完成格式校验；不初始化运行时包目录、不执行应用启动或访问个人进度。

来源为 \`content/materials.db\`、\`content/material_matches.db\`、\`content/content.db\`。JSON保存三库完整文件SHA256、快照元数据、字面匹配索引新鲜度、中英全文原始SHA256、规范化英文SHA256、别名与题图关联，**没有保存原文**。25篇抽读及5个边界案例的结论固定在脚本，并绑定当时英中全文SHA256，来源变化时标为待重新抽读。

字面匹配索引新鲜度：materials=${report.indexFreshness.materials}，wordInventory=${report.indexFreshness.wordInventory}，wordForms=${report.indexFreshness.wordForms}。覆盖重新由正文token计算，绝不把分支命中次数或重叠词形出现次数相加作为覆盖。

### 词表口径纠偏

本地上海中考书只有1804词，缺少a、I、the、you等部分基础条目。这是词表范围问题，不能解释为学生不认识这些词。基础筛选改用**本地全国中考∪上海中考**，再累计并入上海高考、CET4、CET6；原始上海单书覆盖同时保留。

| 对照来源 | 词数 | 原始上海单书覆盖 | 基础并集覆盖 | 上海高考累计覆盖 |
| --- | ---: | ---: | ---: | ---: |
${report.sampleReviews.slice(0,3).map(review=>{const r=report.candidates.find(row=>row.id===review.id);return `| ${r.title}（${r.id}） | ${r.metrics.words} | ${(r.metrics.rawShanghaiCoverage*100).toFixed(1)}% | ${(r.metrics.coverage.entry*100).toFixed(1)}% | ${(r.metrics.coverage.sh_gaokao*100).toFixed(1)}% |`;}).join('\n')}

只用本地lemma、word_forms和机械缩写处理，不加入外部熟词表。专名、复合词和未映射的英美变体仍降低覆盖。**词表命中率不是学生熟词率，更不等于题目难度**。

| 档位 | 英文词数 | 累计覆盖至少 | 平均句长至多 | 最长句至多 | 有效分句片段至少 |
| --- | --- | ---: | ---: | ---: | ---: |
${levelRows.map(l=>`| ${l.label} | ${l.min}—${l.max} | ${Math.round(l.coverage*100)}% | ${l.average} | ${l.longest} | ${l.sentences} |`).join('\n')}

这是项目筛选规则，未经真题等值或学生试用校准，不把Flesch换算考试级别。Intl.Segmenter分句后，至少3词的片段参与句长统计；这不保证每段是语法完整句。任何分档都需复核体裁、认知推理、文化前情和题点独立性。

### 题图覆盖

计入本地存在、库中宽高至少1024×480且横宽比≥1.6、与角色／章节有直接关联的官方素材，以及现成练习已经人工核对的题图。检查文件存在与数据库尺寸，未重新逐图解码或重新鉴别出处。书籍没有关联时保留文字候选，不自动塞无关角色图；“待关联”不表示本地绝无可用图片。

## 抽样发现

抽读25份英文全文：每档5份；基础档同时读完整中文，其余读中文开头和结尾片段。再核查5个书信、连载、重复、语音与分支边界。**这不是逐句双语对齐认证，也不是已完成25篇命题。**

| 档位 | 材料ID | 抽样判断 | 具体限制 |
| --- | --- | --- | --- |
${report.sampleReviews.map(r=>`| ${levelRows.find(l=>l.id===r.level).label} | \`${r.id}\` | ${r.sourceMatches?r.status:'来源变化，须重读'} | ${r.notes.replace(/\|/g,'／')} |`).join('\n')}

### 边界与局部相似

${report.boundaryReviews.map(r=>`- \`${r.id}\`：${r.sourceMatches?r.finding:'来源变化，历史结论须重新核对。'}`).join('\n')}

雷泽故事1与2不是精确重复，但共同涉及狼群生活、人与狼的关系；桑多涅1／2／3共享阿兰和家庭背景。当前只做了这些局部相似抽样，**没有完成全库近重复或重复题点扫描**，不能把精确去重后的每份都当完全独立的新信息。

## 每档优先人工审核前10

以下均是新增来源，按关联题图、自动风险较少、词表覆盖较高排序。抽读已指出的限制仍须遵守，未抽读项目只经过自动检查；完整清单见JSON。

${levelRows.map(l=>`### ${l.label}

| 材料ID | 标题 | 词数 | 原始上海／本档累计覆盖 | 题图 | 初步题型 | 阻碍 |
| --- | --- | ---: | --- | --- | --- | --- |
${report.priority[l.id].map(r=>`| \`${r.id}\` | ${r.title.replace(/\|/g,'／')} | ${r.metrics.words} | ${(r.metrics.rawShanghaiCoverage*100).toFixed(1)}%／${(r.metrics.coverage[l.id]*100).toFixed(1)}% | ${r.image?'有':'待关联'} | ${r.suggestedFormats.join('、')} | ${[...r.risks,report.sampleReviews.find(review=>review.id===r.id)?.status||'独立性／配对／题点待审'].join('；')} |`).join('\n')}
`).join('\n')}
## 使用限制与下一步

先审核主档候选的情境与双语，再按具体题型选篇和命题。长来源先人工确定完整原句段落与1:N中译对应；不据长度直接切窗。任务先复原并固定相同路径，语音先确认说话者、指代和足够信息量。所有收藏与答案证据仍应绑定来源及段号。

现成26篇的人工核对只覆盖各自选段，不代表其整本书、同角色所有故事或全部任务齐备。幻想叙事较多，真实社会应用文、说明文、学术论证的体裁分布有限；可用于训练，但不能宣称覆盖某考试全部阅读能力。没有学生用时／正确率数据，不能据此给出已验证的难度或每篇固定题数。
`;
}

async function main(){
  const library=new Database(path.join(content,'materials.db'),{readonly:true,fileMustExist:true});
  const words=new Database(path.join(content,'content.db'),{readonly:true,fileMustExist:true});
  const matches=new Database(path.join(content,'material_matches.db'),{readonly:true,fileMustExist:true});
  for(const db of [library,words,matches])db.pragma('query_only=ON');
  try{
    const fileNames=['materials.db','content.db','material_matches.db'];
    const databaseFingerprints=Object.fromEntries(await Promise.all(fileNames.map(async name=>[name,{bytes:fs.statSync(path.join(content,name)).size,sha256:await fileHash(path.join(content,name))}])));
    const definitions=readyDefinitions();
    const authoredIds=new Set(definitions.map(p=>p.materialId)),authoredHashes=new Set();
    const packagedSources=new Map(packagedReadingInventory.data.sources.map(source=>[source.id,source]));
    const authored=definitions.map(p=>{const source=packagedSources.get(p.materialId),en=source?.en,chs=source?.chs;
      if(!en||!chs||sha(en.text)!==p.textSha256||sha(chs.text)!==p.chsTextSha256||!p.bilingualAlignmentVerified)throw Error('Authored source version mismatch: '+p.exerciseId);
      authoredHashes.add(sha(normalize(en.text)));return {id:p.exerciseId,level:p.level,materialId:p.materialId,title:p.title,questionCount:p.questions.length,enSha256:p.textSha256,chsSha256:p.chsTextSha256,coverPath:p.coverPath,imageExists:imageExists(p.coverPath),bilingualReview:'author-verified-selected-rows'};});
    const wordRows=words.prepare('SELECT id,lemma FROM words ORDER BY id').all(),formRows=words.prepare('SELECT form,word_id FROM word_forms ORDER BY form,word_id').all();
    const memberships=words.prepare('SELECT book_id,word_id FROM book_words ORDER BY book_id,word_id').all();
    const rankById=new Map(),rawShanghai=new Set();
    const bookRank={zhongkao:0,sh_zhongkao:0,sh_gaokao:1,cet4:2,cet6:3};
    for(const m of memberships){if(m.book_id==='sh_zhongkao')rawShanghai.add(m.word_id);if(bookRank[m.book_id]!==undefined)rankById.set(m.word_id,Math.min(rankById.get(m.word_id)??99,bookRank[m.book_id]));}
    const forms=new Map(),rawForms=new Set();
    for(const row of [...wordRows.map(w=>({form:w.lemma,word_id:w.id})),...formRows]){const term=normalize(row.form);if(rankById.has(row.word_id))forms.set(term,Math.min(forms.get(term)??99,rankById.get(row.word_id)));if(rawShanghai.has(row.word_id))rawForms.add(term);}
    const variants=term=>[term,term.replace(/'s$/,''),term.replace(/'(?:m|re|ve|ll|d)$/,''),({"can't":'can',"won't":'will',"shan't":'shall'}[term]??term.replace(/n't$/,''))];
    const tokenRank=term=>Math.min(...variants(term).map(form=>forms.get(form)??99));
    const segmenter=new Intl.Segmenter('en',{granularity:'sentence'});
    function metrics(text){const ts=tokens(text),ranks=ts.map(tokenRank);const lengths=[...segmenter.segment(text)].map(s=>tokens(s.segment).length).filter(n=>n>=3);return {words:ts.length,sentences:lengths.length,averageSentence:round(lengths.reduce((n,x)=>n+x,0)/(lengths.length||1)),longestSentence:Math.max(0,...lengths),rawShanghaiCoverage:round(ts.filter(t=>variants(t).some(v=>rawForms.has(v))).length/(ts.length||1)),coverage:Object.fromEntries(levels.map(l=>[l.id,round(ranks.filter(rank=>rank<=l.rank).length/(ts.length||1))]))};}
    const imageRows=library.prepare('SELECT * FROM artwork ORDER BY id').all(),imageById=new Map(imageRows.map(row=>[row.id,row]));
    const scopeImages=new Map();for(const scope of library.prepare('SELECT * FROM artwork_scopes ORDER BY artwork_id,scope_kind,scope_id').all()){const a=imageById.get(scope.artwork_id);if(a.width>=1024&&a.height>=480&&a.width/a.height>=1.6&&imageExists(a.file_path)){const key=scope.scope_kind+':'+scope.scope_id;if(!scopeImages.has(key))scopeImages.set(key,{path:a.file_path,association:scope.evidence});}}
    const authoredImages=new Map(definitions.filter(p=>imageExists(p.coverPath)).map(p=>[p.materialId,{path:p.coverPath,association:'existing-author-verified-exercise'}]));
    const hitCounts=new Map(matches.prepare('SELECT material_id,count(*) words FROM word_hits GROUP BY material_id ORDER BY material_id').all().map(r=>[r.material_id,r.words]));
    const graphs=new Map(library.prepare("SELECT material_id,count(*) nodes,sum(json_array_length(options_json)>1) branchingNodes FROM dialogue_nodes WHERE locale='en' GROUP BY material_id ORDER BY material_id").all().map(r=>[r.material_id,r]));
    const rows=library.prepare("SELECT m.*,c.title_en collection_title,e.text en,e.paragraphs_json en_paragraphs,e.title title,e.path_policy,e.source_page,z.text chs,z.paragraphs_json chs_paragraphs,z.title title_chs FROM materials m LEFT JOIN collections c ON c.id=m.parent_id LEFT JOIN texts e ON e.material_id=m.id AND e.locale='en' LEFT JOIN texts z ON z.material_id=m.id AND z.locale='chs' ORDER BY m.id").all();
    const groups=new Map(),issues={};let nonempty=0;
    for(const row of rows){const en=row.en?{text:row.en,paragraphs_json:row.en_paragraphs}:null,chs=row.chs?{text:row.chs,paragraphs_json:row.chs_paragraphs}:null;row.problems=structuralProblems(en,chs);for(const problem of row.problems)issues[problem]=(issues[problem]||0)+1;if(!normalize(row.en))continue;nonempty++;const hash=sha(normalize(row.en));if(!groups.has(hash))groups.set(hash,[]);groups.get(hash).push(row);}
    const taskKinds=new Set(['quest_dialogue','companion_dialogue','quest_narration']),records=[],tasks=[],voices=[],excluded=[];
    const representativeScore=row=>(row.problems.length?0:1000)+(['book','character_story'].includes(row.kind)?100:row.kind==='voice'?50:0)+(authoredIds.has(row.id)?10:0);
    for(const [hash,aliases] of groups){aliases.sort((a,b)=>representativeScore(b)-representativeScore(a)||a.id.localeCompare(b.id,'en'));const row=aliases[0],m=metrics(row.en);const risks=riskFlags(row.en,row.title||'');const image=authoredImages.get(row.id)||scopeImages.get('character:'+row.character_id)||scopeImages.get('quest_chapter:'+row.chapter_id)||null;const isAuthored=aliases.some(a=>authoredIds.has(a.id))||authoredHashes.has(hash);const aliasTitles=[...new Set(aliases.map(a=>a.title||'').filter(Boolean))].sort();if(aliasTitles.length>1)risks.push('duplicate_text_different_titles');const collection=row.collection_title||'';const title=row.title||row.id;const base={id:row.id,aliases:aliases.map(a=>a.id).sort(),aliasTitles,kind:row.kind,title:collection&&!title.startsWith(collection)?collection+' · '+title:title,titleChs:row.title_chs||'',enSha256:sha(row.en),chsSha256:row.chs?sha(row.chs):null,normalizedEnglishSha256:hash,metrics:m,image,risks,problems:row.problems,authored:isAuthored,matchedLocalWordIds:hitCounts.get(row.id)||0,bilingualAlignment:isAuthored?'selected-rows-already-authored':'not-manually-verified',sourcePage:row.source_page||'',suggestedFormats:m.words<180?['事实选择','限定原文信息提取']:m.words<400?['细读选择','语境完形']:['细读选择','语篇衔接／信息匹配需审']};
      const taskAlias=aliases.find(a=>taskKinds.has(a.kind));
      if(taskAlias&&!taskKinds.has(row.kind))tasks.push({id:taskAlias.id,aliases:base.aliases,kind:taskAlias.kind,normalizedEnglishSha256:hash,enSha256:sha(taskAlias.en),chsSha256:taskAlias.chs?sha(taskAlias.chs):null,previewWords:m.words,problems:taskAlias.problems,image:Boolean(image),graph:graphs.get(taskAlias.id)||null,previewOnly:true,authored:isAuthored,alsoRepresentedOutsideTaskPool:true});
      if(taskKinds.has(row.kind)){tasks.push({id:row.id,aliases:base.aliases,kind:row.kind,normalizedEnglishSha256:hash,enSha256:base.enSha256,chsSha256:base.chsSha256,previewWords:m.words,problems:base.problems,image:Boolean(image),graph:graphs.get(row.id)||null,previewOnly:true,authored:isAuthored});continue;}
      const support=row.problems.length?[]:levels.filter(l=>fit(m,l)).map(l=>l.id);
      if(row.kind==='voice'){if(support.length)voices.push({...base,category:'short_voice_context_review',support});continue;}
      if(!['book','character_story'].includes(row.kind)||row.path_policy!=='original'){excluded.push({id:row.id,reason:'unsupported_source_policy'});continue;}
      if(row.problems.length){excluded.push({id:row.id,reason:row.problems.join(',')});continue;}
      const long=m.words>800,eligible=long?levels.filter(l=>fit(m,l,true)).map(l=>l.id):support;
      if(!eligible.length){excluded.push({id:row.id,reason:'outside_screening_thresholds'});continue;}
      records.push({...base,category:long?'long_source_selection_review':'static_short_candidate',primary:eligible[0],support:eligible});
    }
    records.sort((a,b)=>a.id.localeCompare(b.id,'en'));tasks.sort((a,b)=>a.id.localeCompare(b.id,'en'));voices.sort((a,b)=>a.id.localeCompare(b.id,'en'));
    const primary=records.filter(r=>r.category==='static_short_candidate'),long=records.filter(r=>r.category==='long_source_selection_review');
    const summary={rawMaterials:rows.length,rawByKind:countBy(rows,r=>r.kind),nonemptyEnglish:nonempty,distinctEnglish:groups.size,duplicateRows:nonempty-groups.size,issues,
      ready:{exercises:authored.length,sourceMaterials:authoredIds.size,questions:authored.reduce((n,p)=>n+p.questionCount,0)},
      tasks:{raw:rows.filter(r=>taskKinds.has(r.kind)).length,distinctPreviews:new Set(rows.filter(r=>taskKinds.has(r.kind)&&normalize(r.en)).map(r=>sha(normalize(r.en)))).size,representedByTask:tasks.length,branchingGraphs:[...graphs.values()].filter(g=>g.branchingNodes>0).length},
      voices:{raw:rows.filter(r=>r.kind==='voice').length,distinct:new Set(rows.filter(r=>r.kind==='voice'&&normalize(r.en)).map(r=>sha(normalize(r.en)))).size,screened:voices.length},
      static:{raw:rows.filter(r=>['book','character_story'].includes(r.kind)).length,distinctNonempty:new Set(rows.filter(r=>['book','character_story'].includes(r.kind)&&normalize(r.en)).map(r=>sha(normalize(r.en)))).size,primary:primary.length,newPrimary:primary.filter(r=>!r.authored).length,primaryWithRisk:primary.filter(r=>r.risks.length).length,long:long.length},levels:Object.fromEntries(levels.map(l=>[l.id,{readyExercises:authored.filter(p=>p.level===l.id).length,readySources:new Set(authored.filter(p=>p.level===l.id).map(p=>p.materialId)).size,primary:primary.filter(r=>r.primary===l.id).length,newPrimary:primary.filter(r=>r.primary===l.id&&!r.authored).length,newPrimaryWithImage:primary.filter(r=>r.primary===l.id&&!r.authored&&r.image).length,newPrimaryWithoutImage:primary.filter(r=>r.primary===l.id&&!r.authored&&!r.image).length,primaryWithRisk:primary.filter(r=>r.primary===l.id&&r.risks.length).length,crossSupport:primary.filter(r=>r.support.includes(l.id)).length,longSources:long.filter(r=>r.support.includes(l.id)).length}]))};
    const priority=Object.fromEntries(levels.map(l=>[l.id,primary.filter(r=>r.primary===l.id&&!r.authored).sort((a,b)=>Number(Boolean(b.image))-Number(Boolean(a.image))||a.risks.length-b.risks.length||b.metrics.coverage[l.id]-a.metrics.coverage[l.id]||a.id.localeCompare(b.id,'en')).slice(0,10)]));
    const matchingMeta=Object.fromEntries(matches.prepare('SELECT key,value FROM meta ORDER BY key').all().map(r=>[r.key,JSON.parse(r.value)]));
    const wordInventorySha256=sha(JSON.stringify(wordRows)),wordFormsSha256=sha(JSON.stringify(formRows));
    const bindReview=review=>{const row=rows.find(r=>r.id===review.id),evidence=reviewedSourceHashes[review.id];return {...review,reviewedSourceSha256:evidence,sourceMatches:Boolean(row&&evidence&&sha(row.en||'')===evidence.en&&sha(row.chs||'')===evidence.chs)};};
    const report={schemaVersion:3,readingPackage:{id:packagedReadingInventory.data.manifest.id,version:packagedReadingInventory.data.manifest.version,digest:packagedReadingInventory.digest},ruleVersion:'2026-10-22-static-screen-v1',databaseFingerprints,sourceMeta:Object.fromEntries(library.prepare('SELECT key,value FROM meta ORDER BY key').all().map(r=>[r.key,JSON.parse(r.value)])),matchingMeta,wordInventorySha256,wordFormsSha256,indexFreshness:{materials:matchingMeta.source_materials_sha256===databaseFingerprints['materials.db'].sha256,wordInventory:matchingMeta.word_inventory_sha256===wordInventorySha256,wordForms:matchingMeta.word_forms_sha256===wordFormsSha256},rules:levels,summary,priority,sampleReviews:sampleReviews.map(bindReview),boundaryReviews:boundaryReviews.map(bindReview),authored,candidates:records,shortVoiceCandidates:voices,taskPreviewsForReview:tasks,excludedStatic:excluded};
    fs.writeFileSync(path.join(root,'docs/reading-capacity.json'),JSON.stringify(report,null,2)+'\n',{encoding:'utf8'});
    fs.writeFileSync(path.join(root,'docs/reading-capacity.md'),markdown(report),{encoding:'utf8'});
    console.log(JSON.stringify(summary,null,2));
  }finally{library.close();words.close();matches.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
