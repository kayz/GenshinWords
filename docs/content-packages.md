# 离线内容与词书包管理

应用1.1.0新增“内容管理”，统一查看基础资源、剧情素材、词书和阅读题库。程序、内容版本和个人学习记录各自管理，导入不联网。

## 内容类型

| 类型 | 文件 | 含义 |
| --- | --- | --- |
| 基础资源 | .gwcontent（kind=base） | 本地词典、剧情数据库、图片和音频；同一时刻使用一个完整基础版本 |
| 剧情增补 | .gwcontent（kind=materials） | 用户制作的双语章节、台词及包内题图，可与其他素材包共存 |
| 单词书 | .gwwords（kind=words） | 词书名称、稳定编号和选词清单；引用本地词库，不新增外部词条 |
| 阅读题库 | .gwreading | 独立阅读、题目、解析及自包含双语原文和题图；保留现有格式 |

现有11本词书各有独立作者目录和包编号，位于content-library/word-books/<原词书编号>/。制作输出为content/word-books/<编号>.gwwords。上海词书和其他既有书都保留原编号，学习记录不迁移到新书号。收藏词表独立，不是可导入词书。

## 在软件中管理

打开导航“内容管理”。列表显示包名、类型、版本、作者、数量、最低/最高程序版本、依赖以及使用中/待重启/错误状态。页面列明支持的本地文件类型；它不是联网下载商店。

选择文件后，程序先校验格式、全部文件摘要、兼容要求、依赖、数据和编号冲突，再显示新增/升级/已安装及当前版本；确认后才写入。失败保留可用内容。确认时重新检查文件，预览后篡改会被拒绝。

- 同包同版本同内容：幂等，不新增副本或奖励；有效原包可用于修复本地损坏。
- 同包同版本不同内容、降级、缺依赖和不兼容程序：拒绝。
- 基础/剧情/词书：先准备并记录待激活，重新打开应用后核验并启用。当前运行中的资料继续保持。待激活内容失败时保留原活动版本。
- 阅读包：沿用即时启用、未完成轮次冻结原版本与全局题号奖励去重，详见[阅读包规则](reading-packages.md)。
- 词书更新可增删选词；旧卡片、复习日志、收藏和奖励保留，重新加回该词会沿用记录。旧版本存档保留。

作者名称是包内声明，不代表认证或签名。请使用可信的文件来源。

## 运行时指定资源目录

应用1.2.0支持在“内容管理”选择解包基础目录或成品包目录。解包媒体从原位置只读，成品包经校验存入受管缓存。目录载入可在当前运行中启用；上述待重启规则仍适用于单文件导入。目录分别记住，重新扫描后确认更新；错误逐项报告。详细操作、切换与恢复见[资源目录说明](resource-directories.md)。

## 作者制作

本文提及的现有词书作者目录和素材示例，随独立下载的作者资源提供，不随GitHub源码分发。也可按格式自行创建新作者目录。

安装项目依赖后，无需构建或启动Electron。使用Node.js22.12+。清单至少含id/name/kind/version/minAppVersion/author/createdAt；可给description、maxAppVersion与dependencies（id/minVersion）。每个作者使用自己的命名空间，不占用genshinwords保留编号。

词书作者目录为manifest.json与data.json。data示例：

```json
{"books":[{"id":"evening-words","name":"Evening Words","name_zh":"晚间词语","description":"本地选词示例","lemmas":["pursuit","freedom","journey"]}]}
```

第三方词书的运行时编号为包编号:书编号，避免与其他作者撞号。升级时保持包编号与书编号；词表以新版本为准，仍须全部能在本地词典中找到。官方词书保留既有书号，由随应用注册的对应包维护。

剧情包也使用manifest.json、data.json与可选images/。data包含chapters数组，每章有稳定id、英中标题、type（quest/voice/hangout/book）、游戏版本、sourceUrl和quests；任务含id、双语标题和lines，台词含id/speaker/text_en/text_chs。coverPath引用包内images/...图片。参考content-library/examples/noelle-evening/。

同包原章节/任务/台词ID不能转给别的内容；既有英文或归属变更须新ID，旧台词保留供历史来源访问。中文与题图可修订。程序生成固定SQL写入自己的派生缓存，不执行作者SQL或脚本。

```powershell
npm run content:validate -- content-library/examples/local-word-book.gwwords
npm run content:pack -- content-library/examples/local-word-book --out release/local-word-book.gwwords
npm run content:pack -- content-library/examples/noelle-evening --out release/noelle-evening.gwcontent
npm run words:build-base
```

完整基础包可从现有资料目录只读制作，独立清单无需写入原content目录：

```powershell
npm run content:pack -- content --manifest content-library/base/manifest.json --out release/genshinwords-base-1.0.0.gwcontent
npm run content:validate -- release/genshinwords-base-1.0.0.gwcontent
```

基础包只包含运行需要的content.db/materials.db、松散图片/音频与必要来源元数据；不带阅读包、词书包、个人记录、匹配索引或开发报告。当前作者输入需有松散媒体；不能以未经检查的assets.asar替代。基础更新必须保留已存在词ID对应的lemma、剧情编号/归属和原英文，避免旧记录错配；新内容使用新编号。

发布前人工检查译文、来源、版权许可、选词和难度，记录包编号、版本、兼容要求与文件SHA-256。把单个包作为发行附件；现有阅读题型或词书清单更新无需构建EXE。本项目现有资源不上传到GitHub仓库或Release，使用README预留的独立下载地址；分发方式见[发布说明](releasing.md)。

## 格式与存储

基础/剧情/词书使用格式v1：ASCII魔数GWCONTENT1加换行，4字节大端头长度，UTF-8 JSON清单，随后为清单顺序的原始文件字节。每项有安全相对路径、长度和SHA-256；规范清单摘要标识内容版本。严格白名单阻止越界路径、脚本、任意附件及个人学习表。包为离线容器，不是可执行文件，也不以扩展名替代实际检查。

原音频中有1712个WAV和1个Ogg使用.mp3扩展名，包校验兼容这些真实音频头，不改写原媒体；图片仍校验实际类型与像素。

大基础包按块处理。导入时完整校验，已激活内容使用收据和必要文件检查，避免每次启动重新处理全部媒体；访问包内媒体时再核对。派生缓存可重建，不存个人学习记录。Windows默认内容目录为%LOCALAPPDATA%/GenshinWords/content-packages；个人progress.db及原阅读包目录沿用原位置。GENSHINWORDS_USER_DATA和GENSHINWORDS_CONTENT_PACKAGES_DIR可用于隔离开发检查。

基础包目前整包更新，不提供差分；旧存档会继续占用磁盘。

当前没有卸载包、回滚界面、旧存档自动清理、发布者数字签名、可视化作者编辑器或联网包商店。素材不自动生成试题；需另制.gwreading。基础包的媒体目前仍在首次导入时写为本地文件，完整素材的导入耗时和磁盘占用需按实际规模评估。

检查结果见[1.1.0验收记录](content-packages-verification.md)。
