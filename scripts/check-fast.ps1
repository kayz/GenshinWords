$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
    & npm.cmd run reading:build-base
    if ($LASTEXITCODE -ne 0) { throw '基础阅读包制作与校验失败' }
    & npm.cmd run words:build-base
    if ($LASTEXITCODE -ne 0) { throw '基础词书包制作与校验失败' }
    & npm.cmd run typecheck
    if ($LASTEXITCODE -ne 0) { throw "类型检查失败（退出码 $LASTEXITCODE）" }
    & npm.cmd run test:ipc
    if ($LASTEXITCODE -ne 0) { throw "IPC 接口回归失败（退出码 $LASTEXITCODE）" }
    & npm.cmd run test:content-packages
    if ($LASTEXITCODE -ne 0) { throw '素材与词书版本管理回归失败' }
    & npm.cmd run test:resource-directories
    if ($LASTEXITCODE -ne 0) { throw '资源目录定位与运行时载入回归失败' }
    & npm.cmd run test:installer-base
    if ($LASTEXITCODE -ne 0) { throw '安装程序基础素材载入回归失败' }
    & npm.cmd run test:blockers
    if ($LASTEXITCODE -ne 0) { throw "阻塞缺陷回归失败（退出码 $LASTEXITCODE）" }
    & npm.cmd run test:practice
    if ($LASTEXITCODE -ne 0) { throw "练习链路回归失败（退出码 $LASTEXITCODE）" }
    & npm.cmd run test:reading
    if ($LASTEXITCODE -ne 0) { throw "分级阅读回归失败（退出码 $LASTEXITCODE）" }
    & npm.cmd run test:study-options
    if ($LASTEXITCODE -ne 0) { throw '学习批次与剧情分类回归失败' }
    & npm.cmd run test:portraits
    if ($LASTEXITCODE -ne 0) { throw "立绘规则回归失败（退出码 $LASTEXITCODE）" }
    & npm.cmd run check:content
    if ($LASTEXITCODE -ne 0) { throw "离线资料完整性检查失败（退出码 $LASTEXITCODE）" }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "构建失败（退出码 $LASTEXITCODE）" }
}
finally {
    Pop-Location
}
