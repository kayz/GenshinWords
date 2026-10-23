# 离线阅读包：制作、校验、导入与发布

## 现在如何维护

本机现有阅读内容的唯一作者源是 `reading-library/base/` 中的 JSON 与素材；运行时读取同一格式的 `.gwreading` 文件。原 TypeScript 内容模块及手写注册表已迁移、移除。展示、判分、收藏、奖励和 PDF 仍由程序实现。增加现有题型的篇目只发布阅读包，无需构建 Electron 或更新 EXE。

本次基础包 `genshinwords.base@1.0.0` 包含 **69 篇、381 道逻辑题、66 份来源和46张图片**；原有五个历史目录仅用于旧链接兼容，不进入阅读目录。第二、三批已制作内容全部纳入，没有按旧文档数量截断。每篇独立作答、提交、判分和导出，不设置整卷。

现有阅读作者资料与示例从README所列独立下载地址取得，不上传到GitHub仓库或Release。以下路径指下载后恢复到本地的作者目录。

## 给使用者

1. 打开“分级阅读”，点击“导入阅读包”，选择本机的 `.gwreading`。
2. 程序先完整校验，显示包名称、版本、篇目数和安装／升级／已安装状态。确认后才启用。
3. 导入结果和已安装阅读包可以在同一位置查看；失败显示原因，原有可用包继续保留。

文件可以通过U盘传递，导入和阅读均不联网。基础阅读包随安装程序提供；补充包保存在用户本地，不必放在 EXE 旁边。导入不清空复习、收藏、成绩或原石。

### 更新与编号规则

| 情况 | 行为 |
| --- | --- |
| 同包、同版本、同内容 | 提示已安装；不会新增目录或重复奖励。也可修复同版本损坏的本地资源。 |
| 同包、较高版本 | 完整校验后切换当前版本，保留旧版本。 |
| 同包、同版本却内容不同 | 拒绝；作者必须提升包版本。 |
| 较低版本 | 拒绝降级；应用自带的较旧基础包不会覆盖已导入的新基础包。 |
| 不同包复用题号 | 判分相关内容相同时允许；此逻辑题只奖励一次。 |
| 不同包复用篇目或历史目录编号 | 只有篇目内容完全一致时允许，否则拒绝。建议每个作者使用独立篇目命名空间。 |
| 原题号的题干、选项、答案、可接受变式、空位或英文来源改变 | 拒绝；这些变更必须使用新题号，避免重新解释旧成绩。 |
| 仅修订解析、中文译文、图片等 | 可提升包版本，保留逻辑题号；仍须通过全部来源、映射和资源校验。 |
| 已有未完成轮次 | 继续冻结的旧版本；页面提示有新版，可主动开始新版新轮。不会把旧答案套到新版。 |
| 新版本删除某篇 | 当前目录隐藏它；历史来源链接和成绩仍可读取存档，并可基于存档重练。已有题号不重新发奖。 |

每轮记录 `content_revision`（包内容摘要），题面、判分、解析、点词和PDF都按这一版本读取。新的收藏与奖励来源另外保存轮次编号，回到来源时恢复对应轮次；旧来源仅在可靠匹配到原轮次时补齐，不能唯一定位的旧记录保留快照。旧的无版本轮次在首次加载／升级前绑定迁移后的基础版本。收藏保留当时的原句、译文、标题、题图和位置；奖励明细保留获奖时快照。不同版本的正确题不会拼接成一次全对成绩。

## 作者环境与命令

需要 Node.js 22.12 或更新版本和项目依赖，包含 TypeScript 与 sharp；不需要启动或构建 Electron，不需要 SQLite 资料库或学习记录。工具仅执行仓库自身的可信校验代码，不执行作者目录或阅读包中的脚本。运行前按项目方式安装依赖。

```powershell
# 校验作者目录
npm run reading:validate -- reading-library/examples/shared-question

# 打包成一个可分发文件
npm run reading:pack -- reading-library/examples/shared-question --out demo.gwreading

# 再校验最终交付文件
npm run reading:validate -- demo.gwreading

# 构建应用前，从唯一作者源生成基础包
npm run reading:build-base
```

也可直接运行 `node scripts/reading-package.cjs validate <目录或文件>`、`node scripts/reading-package.cjs pack <目录> --out <文件>`。输出包含包编号、版本、规范JSON的内容摘要、篇目／逻辑题／来源／图片数量；发布时Get-FileHash给出的文件字节摘要与该内容摘要用途不同。任何错误返回非零退出码。新增 JSON 文件会自动纳入，无注册用 TS 文件。

### 作者目录

```text
my-reading/
  manifest.json
  units/
    001-my-reading-v1.json
    002-another-reading-v1.json
  sources/
    001-source.json
  images.json
  assets/
    character.png
  legacy-groups.json    # 可省略；新内容通常不需要
```

`units/` 和 `sources/` 的 JSON 文件按文件名排序，数值前缀控制目录顺序。文件名不承担逻辑编号。图片清单的 `file` 是作者目录内的相对文件路径；打包时检查真实路径，不能通过 `..`、绝对路径、盘符、UNC 或符号链接逃出作者目录。

建议复制示例目录后修改 `manifest.id/name/version`、篇目编号及内容。真正新增逻辑题必须分配自己的稳定题号；如果只是复用同一道题，应保留题号及其判分内容。示例故意复用基础题库雷泽阅读的3道题，便于检查跨包奖励去重。

### 包清单

```json
{
  "id": "myteam.middle-reading",
  "name": "提瓦特阅读补充 · 中考",
  "version": "1.0.0",
  "minAppVersion": "1.0.0",
  "engineVersion": 1,
  "createdAt": "2026-10-23",
  "description": "独立阅读与配套双语、题图"
}
```

`version`、`minAppVersion`、可选的 `maxAppVersion` 使用语义版本。程序导入时核对当前应用版本；格式、题型和判分能力始终严格校验。作者工具不以当前 EXE 版本限制未来包的兼容区间，实际导入仍会拒绝不兼容包。日期是有效 ISO 日期或 UTC 时间。

## 格式 v1

文件是 **gzip 压缩的 UTF-8 JSON**，不是任意文件压缩包。顶层字段固定：

| 字段 | 含义 |
| --- | --- |
| `format` | 固定为 `genshinwords.reading` |
| `formatVersion` | 当前为 `1` |
| `manifest` | 包身份、版本、名称、程序／引擎兼容要求 |
| `units` | 独立篇目和全部题目、答案、解析 |
| `legacyGroups` | 历史目录到独立篇目的引用，不复制题目 |
| `sources` | 官方英文、中文完整原文、各自段落与 SHA-256、来源链接 |
| `images` | PNG／JPEG／WebP字节、类型、SHA-256及官方出处 |

不含学习数据、可执行代码、HTML模板、SVG、脚本或任意附件；未知字段会被拒绝。类型定义见 `src/shared/reading-package.ts`、`src/main/reading-paper-types.ts` 和 `src/main/reading-bank-types.ts`；可直接参照示例 JSON。

### 篇目与题型

新篇目使用 `{ "kind": "passage", "definition": { ... } }`。definition至少包含：

- `id/title/level/type/instructions`：稳定篇号、标题、级别、题型和考生提示；可给出建议分钟数。
- `materialId/textSha256/chsTextSha256`：引用包内完整来源；必须逐字匹配两种语言的 UTF-8 SHA-256。
- `bilingualAlignmentVerified: true`、`paragraphMap`：作者人工审核过的英中源段映射。
- `coverPath/coverFocus/sourceTitle/sourceUrl`：包内题图、0—1范围焦点和文字出处。
- `questions/glossary/analysis`：题目、题面难词和讲解；专名解释放 `analysisGlossary`。
- 必要时提供 `masks/optionPool/paragraphLabels`。

级别为 `entry/sh_zhongkao/sh_gaokao/cet4/cet6`。篇目题型为 `reading/cloze/initial-fill/word-bank/sentence-gap/matching/information`；底层题目使用 `choice` 或 `fill`。新内容复用这些能力无需升级程序；新增判分类型或引擎版本需要新 EXE。

每题含稳定 `id`、`type`、题干、题型显示名、能力描述、提示、`expected` 和 `solution`。选择题给出选项或引用共享池；填答题可给 `accepted`、首字母和长度约束。solution含对应题号、标准答案、答案编号、解析、证据段号及逐项选项说明。标准答案必须与判分答案一致，不能只改其中一份。

逻辑题指纹覆盖判分所依赖的题干、选项、标准／可接受答案、约束、完整英文来源及该题自己的空位。增加其他题目的空位不会改变原题身份。解析和中文修订不改变逻辑题身份。篇号／题号不能借更新转给另一项内容。

### 双语、映射、空位与解释

sources中每条记录有 `id/title/url` 和 `en/chs`，后两者分别为 `{ text, sha256, paragraphs: string[] }`。保留官方完整文本和原段顺序，不把译文推断为逐句对齐；SHA使用原字符串UTF-8字节，不自行规范化或改标点。

`paragraphMap` 的 `en` 和 `chs[]` 使用**来源原段的1起始编号**，允许一英对多中，按原顺序选完整段。证据、结构解析、重点句及段落标签同样引用来源原段；程序再换算成本篇显示P号。设置人工核验标记不能替代人工审阅译文差异、答案唯一性和难度。

每个mask为 `{ paragraph, start, end, questionId, expectedText }`；字符范围是该英文原段的UTF-16索引，半开区间。必须满足 `paragraph.slice(start,end) === expectedText`；空位不能越界、重叠、引用外来题号或与标准答案矛盾。首字母题的标准／可接受变式也必须满足首字母约束。讲解重点句必须确实出现在所指原段。

低级别只对普通难词给必要括注，避免把考查词或答案变式提前解释出来；原神专名放解答区。文本解析包括概述、结构和重点句；词义、干扰项分析、英中差异及难度仍需作者审核。

### 图片

作者 `images.json` 每项包含 `path/file/mimeType/sha256/sourceTitle/sourceUrl`。打包后去掉作者文件路径，写入 `dataBase64`。篇目的coverPath指向逻辑path，不能引用包外磁盘文件。只用官方人物立绘或经审阅的相关官方活动图，不用游戏截图。按4:1裁切，coverFocus用0—1坐标保留脸或主体。

校验会检查真实文件类型、完整容器、图片像素与SHA；扩展名不代替真实类型。程序按摘要生成自己的缓存文件名，不按包中路径任意写文件。来源链接仅作署名和审阅信息，不触发下载。

### 限额

格式v1限制：压缩文件64MiB、解压后JSON160MiB；500篇、5000题、1000条来源、256张图片；单图32MiB、总图片96MiB、每图6400万像素；每种语言原文200万字符，并限制JSON深度与节点数。像素解码单批另有30秒上限，超时或超量时缩图、拆成不同包，跨包仍按全局逻辑题号去重。

## 本地存储与故障隔离

默认在 `%APPDATA%\genshin-words\reading-packages\` 保存：

```text
registry.json / registry.backup.json
revisions/<内容摘要>.gwreading
assets/<内容摘要>/<图片摘要>.<真实扩展名>
```

progress.db只增加轮次的版本引用；包不写入个人答案、收藏、成绩或奖励。导入先校验和检查历史编号，再准备存档／资源，最后原子切换目录。激活失败不公布新包；已准备但未激活的文件不影响可用题库。确认时重新读取并对比预览摘要，防止选择后文件被替换。

每个补充包独立加载；损坏包在管理区显示错误，其他包继续可用。重新导入同版本的完整文件可修复。历史轮次所需版本不会静默回退到当前版本；缺失或损坏时明确报错，避免以错误题面解释旧答卷。

测试可用 `GENSHINWORDS_USER_DATA` 和 `GENSHINWORDS_READING_PACKAGES_DIR` 指定隔离位置；不要把它们指向真实用户目录。无轮次、只有段号的旧外部URL无法准确判定历史版本，按当前默认位置打开；新收藏／奖励链接均带轮次，旧题号链接仅在唯一匹配到历史答卷或草稿时恢复，否则明确提示。历史版本目前保留、不自动清理，随着更新会占用磁盘；尚未提供包卸载和存档清理界面。

## 发布检查

1. 人工复核双语、题意、可接受答案、解析、题图主体和出处。
2. 校验目录、打包、再次校验最终文件；记录包ID、版本、摘要、篇目数、兼容应用版本。
3. 使用隔离数据导入，检查答题、整篇提交、解析、收藏、原石和PDF；若更新，包含未完成旧轮。
4. 通过独立下载渠道发布此 `.gwreading` 文件和变更说明；本项目现有资源不上传到GitHub仓库或Release，无需重新发布EXE。

安装程序构建会先从作者源生成相同格式的基础阅读包，通过electron-builder的content资源随安装程序提供。生成的 `content/reading/base.gwreading` 不另作作者源维护。

实际样例为 `reading-library/examples/shared-question.gwreading`，配套作者目录为 `reading-library/examples/shared-question/`。样例自带官方双语和人物图；题号与基础包共享，已获奖励不会再发。

摘要用于完整性与内容版本识别，当前没有发布者数字签名，也不会自动联网更新；发布者身份需通过下载渠道核对。机器校验不能替代内容质量、官方出处及难度的人工审核。

## 回归命令

```powershell
pwsh -NoProfile -File scripts/check-fast.ps1
npm run test:reading-packages
# 先 npm run build，再运行真实Electron界面检查
npm run check:reading-packages-interface
```

迁移基线仅保存69篇公开文档摘要和稳定编号，不复制作者正文。专项回归涵盖自包含离线读取、CLI、路径逃逸、重复／升级／冲突／损坏、激活失败、原成绩和收藏、奖励去重、旧链接、旧草稿与新版新轮。真实Electron检查另覆盖1024宽、4:1图、导入交互、答题解析及实际PDF。所有开发验收使用临时进度和包目录。

本次实际检查范围与结果见[架构验收记录](reading-packages-verification.md)。
