# 构建与分发

## 分发约定

GitHub 用于程序源码、工具、文档和版本说明。**现有学习资源不上传到 GitHub 仓库或 GitHub Release**：包括词库、词书清单、剧情与阅读作者内容、成品内容包及配套图片和发音。

安装程序目前内含基础阅读包和 11 本词书，因此安装程序也通过独立下载渠道提供。GitHub Release 可记录程序版本、变更和下载页链接，不附带现有资源。下载地址由维护者手工填入 [README](../README.md#下载地址)。

内容作者可以按授权通过自己选择的渠道分享自己的内容；本项目现有资源按上述约定分发。

## 构建安装程序

默认目标是 Windows x64 NSIS 安装程序。它包含程序、图标、基础阅读包和 11 个词书包；不包含大型基础数据库、散图片/音频或 assets.asar。

需要 Windows、PowerShell 7、Node.js 22.12 或更新版本、项目依赖，以及另行取得的基础阅读和词书作者目录：

- `reading-library/base/`：阅读作者 JSON 与配套资料。
- `content-library/word-books/`：现有 11 本词书的作者 JSON。

这些现有作者资源不在 GitHub 源码中分发；维护者通过下载渠道另外提供，取得后恢复到相应路径。构建所需工具可能需要联网下载，成品运行与内容导入离线。

```powershell
npm ci
npm run typecheck
npm run build:win
Get-FileHash -Algorithm SHA256 dist/installer/GenshinWords-*-setup-x64.exe
```

`build:win` 调用 `build:installer`，配置为 `electron-builder.install.yml`，输出在 `dist/installer/`。生成的 content/reading 和 content/word-books 是构建输出，不是第二份作者源。

完整发布检查还需要本地完整的 `content/` 工作资料，包括采集库和匹配索引；导入到用户目录的成品包不等同于这些工作文件。资料齐备后运行：

```powershell
pwsh -NoProfile -File scripts/check-fast.ps1
```

## 基础素材单独制作

从本地完整资料目录只读制作，不改动原文件：

```powershell
npm run content:pack -- content --manifest content-library/base/manifest.json --out release/genshinwords-base-1.0.0.gwcontent
npm run content:validate -- release/genshinwords-base-1.0.0.gwcontent
Get-FileHash -Algorithm SHA256 release/genshinwords-base-1.0.0.gwcontent
```

当前输入需要松散媒体。基础包只带运行需要的数据库、媒体和来源元数据，排除学习记录、开发报告、阅读/词书成品包和匹配索引。细则见[内容包规范](content-packages.md)。

首次发行在站外下载页提供“安装程序 + 基础素材包”，并按需提供补充内容包和作者资料。安装向导指定基础包，首次启动校验并载入；已有解包资源目录也可以之后在内容管理中指定。后续程序和内容分别更新。

## 安装时的基础素材选择

Windows 安装程序先查找与自身同目录的 `genshinwords-base*.gwcontent`；只有一个候选文件时在向导中预填，也支持浏览其他位置。没有已有配置的首次安装需要选定可读取的 `.gwcontent` 文件。升级且已有资源配置时默认沿用，用户可主动改选。安装器保存文件路径，首次启动时应用显示准备界面，再以正常内容包校验、编号保护和缓存激活流程载入；失败时可重新选择或进入内容管理。安装器只做轻量文件识别，实际兼容性及资源完整性由应用校验。

建议把安装程序与完整基础素材包放在同一下载目录分发。安装程序仍不内嵌大型基础素材，也不在线下载；用户需同时取得安装程序和基础素材包。升级程序时，如本地基础资源已可用，通常只需替换程序。

## 单独制作词书、素材与阅读

在任意自己的作者目录中编写纯数据，以下为路径示例：

```powershell
npm run content:pack -- my-content/travel-words --out release/travel-words.gwwords
npm run content:validate -- release/travel-words.gwwords

npm run content:pack -- my-content/my-story --out release/my-story.gwcontent
npm run content:validate -- release/my-story.gwcontent

npm run reading:validate -- my-content/my-reading
npm run reading:pack -- my-content/my-reading --out release/my-reading.gwreading
npm run reading:validate -- release/my-reading.gwreading
```

发布前人工复核，使用隔离目录试导入，并记录包ID、版本、兼容要求、依赖、内容数量、SHA-256、来源和变更。作者源若可分发，随内容另行提供，方便使用者继续修改；个人学习目录不随包分享。

同包更新提升版本号，保持已有内容编号；实质改变阅读判分内容需要新题号。新增已有题型、选词或素材不用重发EXE；新增题型或改变判分能力需更新程序。版本规则见[素材/词书说明](content-packages.md)和[阅读包说明](reading-packages.md)。

## 源码发布前

提交程序源码、工具、配置、锁文件、文档和必要的程序界面资产及许可。将 `content/`、`reading-library/base/`、`reading-library/examples/`、`content-library/word-books/`、`content-library/examples/` 中的现有学习资料及 `release/`、`dist/` 生成物排除，确认实际暂存清单不含它们。不要直接全量暂存未审查的工作目录。

本段是分发范围说明，不会自动修改Git跟踪状态。发布前核对 `.gitignore`、`git status --short` 和 `git diff --cached --stat`；已跟踪的资料还需单独处理，加入忽略规则不会自动取消跟踪。源码许可证与第三方内容授权分别核对。

## 验收与保留目标

发布安装程序前，应在干净Windows环境离线检查缺资料引导、资源目录选择/重新扫描/热载入与再次打开、单文件导入/重启、发音/剧情/单词、阅读判分/收藏/PDF、再次打开和升级后的数据保留。安装器构建通过不等于已完成操作系统安装、升级和卸载验证。

历史完整便携构建 `npm run build:portable` 保留，使用 `electron-builder.yml` 封装完整content；不作默认发行方式，不在GitHub分发。既有性能与检查记录见[阅读包验收](reading-packages-verification.md)和[内容管理验收](content-packages-verification.md)。
