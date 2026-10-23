import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContentPackageDependency, ContentPackageInfo, ContentPackagePreview } from '../../../shared/content-package';
import type { ResourceDirectoryLoadResult, ResourceDirectoryPreview, ResourceDirectoryRawInfo, ResourceDirectoryStatus } from '../../../shared/resource-directory';
import './content.css';

type PackageKind = ContentPackageInfo['kind'];
const kindLabels: Record<PackageKind, string> = {
  base: '基础内容包', materials: '素材包', words: '词书包', reading: '阅读包',
};
const statusLabels: Record<ContentPackageInfo['status'], string> = {
  active: '使用中', pending: '待重启生效', error: '未能加载',
};
const actionLabels = { install: '新增内容包', upgrade: '更新已有内容包', unchanged: '已安装相同版本，无需更新' };
const numberFormat = new Intl.NumberFormat('zh-CN');

function contentError(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) return '派蒙没能检查好这个文件，请重新选择内容包。';
  return error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}
function countLabel(counts: ContentPackageInfo['counts']): string {
  const labels: Array<[keyof ContentPackageInfo['counts'], string]> = [
    ['books', '本词书'], ['words', '个词'], ['chapters', '篇资料'], ['readings', '篇阅读'], ['questions', '道题'], ['files', '个文件'],
  ];
  return labels.flatMap(([key, label]) => typeof counts[key] === 'number' ? [`${numberFormat.format(counts[key]!)} ${label}`] : []).join(' · ') || '暂未提供数量';
}
function appVersionLabel(info: ContentPackageInfo): string | null {
  if (info.minAppVersion && info.maxAppVersion) return `${info.minAppVersion} ～ ${info.maxAppVersion}`;
  if (info.minAppVersion) return `${info.minAppVersion} 及以上`;
  if (info.maxAppVersion) return `${info.maxAppVersion} 及以下`;
  return null;
}
function Dependencies({ dependencies, packages }: { dependencies?: ContentPackageDependency[]; packages: ContentPackageInfo[] }) {
  if (!dependencies?.length) return null;
  return <div className="cp-dependencies"><h4>需要的内容</h4><ul>{dependencies.map(dependency => {
    const local = packages.find(item => item.id === dependency.id);
    return <li key={dependency.id}><strong>{local?.name || dependency.id}</strong> · 版本不低于 {dependency.minVersion}
      <span className="gw-muted">{local ? `（本机 ${local.version}，${statusLabels[local.status]}）` : '（本机尚未找到）'}</span></li>;
  })}</ul></div>;
}
function PackageFacts({ info }: { info: ContentPackageInfo }) {
  const appVersions = appVersionLabel(info);
  return <dl className="cp-facts">
    <div><dt>类型</dt><dd>{kindLabels[info.kind]}</dd></div>
    <div><dt>版本</dt><dd>{info.version || '未标注'}</dd></div>
    <div><dt>作者</dt><dd>{info.author || '未标注'}</dd></div>
    <div><dt>内容数量</dt><dd>{countLabel(info.counts)}</dd></div>
    {appVersions ? <div><dt>适用应用版本</dt><dd>{appVersions}</dd></div> : null}
  </dl>;
}
function DirectoryRaw({ raw }: { raw: ResourceDirectoryRawInfo }) {
  return <article className="cp-directory-raw" data-resource-raw-status={raw.status}>
    <div className="cp-heading"><h3>{raw.name || '基础资料目录'}</h3><span className={'cp-badge cp-status-' + (raw.status === 'error' ? 'error' : 'active')}>{raw.status === 'active' ? '正在读取' : raw.status === 'ready' ? '检查通过' : '暂时不可用'}</span></div>
    <p className="cp-directory-path">{raw.path}</p>
    <dl className="cp-facts"><div><dt>资料版本</dt><dd>{raw.version || '未登记'}</dd></div><div><dt>内容数量</dt><dd>{numberFormat.format(raw.wordCount)} 个词 · {numberFormat.format(raw.chapterCount)} 个章节 · {numberFormat.format(raw.lineCount)} 句台词</dd></div></dl>
    {raw.message || raw.status === 'error' ? <p className={raw.status === 'error' ? 'gw-error' : 'gw-muted'} role={raw.status === 'error' ? 'alert' : undefined}>{raw.message || '这个基础目录目前无法读取，请重新连接原目录，或选择可用的资源目录。'}</p> : null}
  </article>;
}

export default function Content() {
  const [packages, setPackages] = useState<ContentPackageInfo[]>([]);
  const [filter, setFilter] = useState<PackageKind | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [preview, setPreview] = useState<ContentPackagePreview | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'importing' | 'directory-checking' | 'directory-scanning' | 'directory-loading'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [restartNotice, setRestartNotice] = useState(false);
  const [directories, setDirectories] = useState<ResourceDirectoryStatus | null>(null);
  const [directoriesLoading, setDirectoriesLoading] = useState(true);
  const [directoryError, setDirectoryError] = useState('');
  const [directoryNotice, setDirectoryNotice] = useState('');
  const [directoryPreview, setDirectoryPreview] = useState<ResourceDirectoryPreview | null>(null);
  const [directoryResult, setDirectoryResult] = useState<ResourceDirectoryLoadResult | null>(null);
  const mounted = useRef(true), operationLock = useRef(false), listRequest = useRef(0);
  const directoryRequest = useRef(0);
  const previewElement = useRef<HTMLDivElement>(null), importButton = useRef<HTMLButtonElement>(null);
  const directoryPreviewElement = useRef<HTMLDivElement>(null), directoryButton = useRef<HTMLButtonElement>(null);
  const busy = phase !== 'idle';
  const pendingCount = packages.filter(item => item.status === 'pending').length;
  const filtered = packages.filter(item => filter === 'all' || item.kind === filter);

  async function refreshPackages() {
    const request = ++listRequest.current;
    setLoading(true); setListError('');
    try {
      const next = await window.api.listContentPackages();
      if (mounted.current && request === listRequest.current) setPackages(next);
    } catch (reason) {
      if (mounted.current && request === listRequest.current) setListError(contentError(reason));
    } finally {
      if (mounted.current && request === listRequest.current) setLoading(false);
    }
  }
  async function refreshDirectories() {
    const request = ++directoryRequest.current;
    setDirectoriesLoading(true);
    try {
      const status = await window.api.getResourceDirectories();
      if (mounted.current && request === directoryRequest.current) { setDirectories(status); setDirectoryError(''); }
    } catch (reason) {
      if (mounted.current && request === directoryRequest.current) setDirectoryError('暂时没能读取资源目录：' + contentError(reason));
    } finally {
      if (mounted.current && request === directoryRequest.current) setDirectoriesLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refreshPackages(); void refreshDirectories();
    return () => { mounted.current = false; listRequest.current += 1; directoryRequest.current += 1; };
  }, []);

  async function chooseDirectory(rescan = false) {
    if (operationLock.current) return;
    operationLock.current = true;
    setPhase(rescan ? 'directory-scanning' : 'directory-checking'); setDirectoryError(''); setDirectoryNotice('');
    try {
      const next = await (rescan ? window.api.rescanResourceDirectory() : window.api.previewResourceDirectory());
      if (!mounted.current) return;
      if (!next) { setDirectoryNotice(rescan ? '还没有可扫描的资源目录，先选一个本机目录吧。' : '取消选择啦，当前资料继续使用。'); return; }
      setDirectoryPreview(next); setDirectoryResult(null); setPreview(null); setError(''); setNotice(''); setRestartNotice(false);
      requestAnimationFrame(() => {
        directoryPreviewElement.current?.scrollIntoView({ block: 'start' });
        directoryPreviewElement.current?.focus({ preventScroll: true });
      });
    } catch (reason) {
      if (mounted.current) { setDirectoryPreview(null); setDirectoryError('这个资源目录没能检查好：' + contentError(reason)); }
    } finally {
      operationLock.current = false;
      if (mounted.current) setPhase('idle');
    }
  }
  async function loadDirectory() {
    if (!directoryPreview?.canLoad || operationLock.current) return;
    operationLock.current = true;
    setPhase('directory-loading'); setDirectoryError(''); setDirectoryNotice('');
    try {
      const result = await window.api.loadResourceDirectory(directoryPreview.token);
      if (!mounted.current) return;
      setDirectoryResult(result); setDirectories(result.status); setDirectoryPreview(null); setFilter('all');
      setDirectoryNotice(result.raw?.status === 'error' ? '基础目录未能切换，当前资料继续使用。具体原因在下方列好啦。' : result.raw?.status === 'active' ? '基础资料已经开始从所选目录读取，咱们可以回首页选词书啦。' : result.failedCount ? '可用的内容已载入；还有内容未通过检查，具体原因在下方列好啦。' : '资源目录已处理，载入情况在下方列好啦。');
      await Promise.all([refreshPackages(), refreshDirectories()]);
      requestAnimationFrame(() => directoryButton.current?.focus({ preventScroll: true }));
    } catch (reason) {
      if (mounted.current) setDirectoryError('这次没能载入资源目录：' + contentError(reason));
    } finally {
      operationLock.current = false;
      if (mounted.current) setPhase('idle');
    }
  }

  async function choosePackage() {
    if (operationLock.current) return;
    operationLock.current = true;
    setPhase('checking'); setError(''); setNotice(''); setRestartNotice(false);
    try {
      const next = await window.api.previewContentPackageImport();
      if (!mounted.current) return;
      if (!next) { setNotice('取消选择啦，咱们接着看内容。'); return; }
      setPreview(next); setDirectoryPreview(null);
      requestAnimationFrame(() => {
        previewElement.current?.scrollIntoView({ block: 'start' });
        previewElement.current?.focus({ preventScroll: true });
      });
    } catch (reason) {
      if (mounted.current) { setPreview(null); setError('这个内容包没能通过检查：' + contentError(reason)); }
    } finally {
      operationLock.current = false;
      if (mounted.current) setPhase('idle');
    }
  }
  async function confirmImport() {
    if (!preview || operationLock.current) return;
    operationLock.current = true;
    setPhase('importing'); setError(''); setNotice(''); setRestartNotice(false);
    try {
      const result = await window.api.importContentPackage(preview.token);
      if (!mounted.current) return;
      setPreview(null); setFilter('all');
      setNotice(`「${result.package.name}」版本 ${result.package.version}${result.action === 'unchanged' ? ' 已安装，无需更新。' : result.action === 'upgraded' ? ' 更新成功。' : ' 导入成功。'}`);
      setRestartNotice(result.restartRequired);
      await Promise.all([refreshPackages(), refreshDirectories()]);
      requestAnimationFrame(() => importButton.current?.focus({ preventScroll: true }));
    } catch (reason) {
      if (mounted.current) setError('这次没能导入内容包：' + contentError(reason));
    } finally {
      operationLock.current = false;
      if (mounted.current) setPhase('idle');
    }
  }

  return <section className="cp-page" aria-busy={busy}>
    <div className="gw-eyebrow">派蒙的旅行背包</div>
    <h1 className="gw-hero-title">内容管理</h1>
    <p className="gw-hero-sub cp-intro">把新的台词、词书和阅读放进背包。选好本机的内容包或资源目录，派蒙先检查，再请你确认。全程离线。</p>
    <div className="gw-actions cp-main-actions">
      <button ref={importButton} type="button" className="gw-btn" disabled={busy} onClick={() => void choosePackage()}>{phase === 'checking' ? '派蒙在检查文件…' : '导入内容包'}</button>
      <button type="button" className="gw-btn gw-btn-ghost" disabled={busy || loading} onClick={() => { void refreshPackages(); void refreshDirectories(); }}>刷新本机列表</button>
      <Link to="/" className="gw-btn gw-btn-ghost">返回学习首页</Link>
    </div>
    {error ? <div className="gw-error cp-feedback" role="alert"><p>{error}</p><p>看看提示里的原因，准备好对应的本机文件后，再让派蒙检查一次吧。</p></div> : null}
    {notice ? <div className="cp-notice cp-feedback" role="status"><p>{notice}</p>{restartNotice ? <p>导入的内容会在下次启动时生效。请自行关闭并重新打开应用，派蒙就能换好内容啦。</p> : null}</div> : null}

    <section className="cp-directories gw-panel" aria-labelledby="resource-directory-title">
      <h2 id="resource-directory-title">资源目录</h2>
      <p>已经解包的基础资料，可以直接选中它所在的目录；也可以选择放有 .gwcontent、.gwwords、.gwreading 文件的目录，让派蒙逐个检查。</p>
      <p className="gw-muted">解包资料会从原目录直接读取，请保留这个目录。内容包会存入本机缓存，检查并确认载入后，就能在这次打开的应用中使用。</p>
      <div className="gw-actions cp-directory-actions"><button ref={directoryButton} type="button" className="gw-btn" disabled={busy} onClick={() => void chooseDirectory()}>{phase === 'directory-checking' ? '派蒙在检查目录…' : '选择资源目录'}</button><button type="button" className="gw-btn gw-btn-ghost" disabled={busy || directoriesLoading} onClick={() => void chooseDirectory(true)}>{phase === 'directory-scanning' ? '派蒙在重新扫描…' : '重新扫描'}</button></div>
      {directoryError ? <div className="gw-error cp-directory-feedback" role="alert"><p>{directoryError}</p><p>当前已可用的内容仍保留，可以按提示检查目录后重试。</p></div> : null}
      {directoryNotice ? <p className="cp-notice cp-directory-feedback" role="status">{directoryNotice}</p> : null}
      {directoriesLoading ? <p className="gw-muted" role="status">派蒙在查看已选的资源目录…</p> : null}
      <div className="cp-directory-current" data-resource-directories>
        <h3>直接读取的基础目录</h3>
        {directories?.raw ? <DirectoryRaw raw={directories.raw} /> : <p className="gw-muted">还没有指定直接读取的基础目录。</p>}
        <h3>最近载入的包目录</h3>
        {directories?.packageDirectory ? <div><p className="cp-directory-path">{directories.packageDirectory}</p><p className={directories.packageDirectoryAvailable ? 'gw-muted' : 'gw-error'} role={directories.packageDirectoryAvailable ? undefined : 'alert'}>{directories.packageDirectoryAvailable ? '目录可用，可以重新扫描其中的内容包。' : '这个目录暂时无法打开。已存入本机缓存的可用内容仍可使用。'}</p></div> : <p className="gw-muted">还没有载入过内容包目录。</p>}
        {directories?.message ? <p className="cp-notice">{directories.message}</p> : null}
        {!loading ? <p className="gw-muted cp-directory-content-summary">当前已载入 {packages.filter(item => item.status === 'active').length} 个内容包，具体内容和错误见下方“本机内容包”。</p> : null}
      </div>
      {directoryPreview ? <div ref={directoryPreviewElement} tabIndex={-1} className="cp-directory-preview" aria-labelledby="resource-directory-preview-title">
        <div className="cp-heading"><h3 id="resource-directory-preview-title">确认载入资源目录</h3><span className="cp-badge">{directoryPreview.kind === 'raw' ? '解包资料目录' : directoryPreview.kind === 'mixed' ? '解包资料与内容包' : '内容包目录'}</span></div>
        <p className="cp-directory-path">{directoryPreview.directory}</p>
        {directoryPreview.raw ? <DirectoryRaw raw={directoryPreview.raw} /> : null}
        {directoryPreview.packages.length ? <div className="cp-directory-package-list"><h4>逐包检查结果</h4>{directoryPreview.packages.map((item, index) => <article key={item.file + ':' + index} className="cp-directory-package" data-resource-package-status={item.status}>
          <div className="cp-heading"><h4>{item.package?.name || item.relativePath}</h4><span className={'cp-badge cp-status-' + (item.status === 'error' ? 'error' : item.status === 'skipped' ? 'pending' : 'active')}>{item.status === 'ready' ? '检查通过' : item.status === 'skipped' ? '本次跳过' : '检查未通过'}</span></div>
          <p className="cp-directory-path">{item.relativePath}</p>
          {item.package ? <PackageFacts info={item.package} /> : null}
          {item.action ? <p className="gw-muted">{actionLabels[item.action]}</p> : null}
          {item.message ? <p className={item.status === 'error' ? 'gw-error' : 'gw-muted'} role={item.status === 'error' ? 'alert' : undefined}>{item.message}</p> : null}
        </article>)}</div> : !directoryPreview.raw ? <p className="gw-muted">没有找到可用的基础资料或支持的内容包。</p> : null}
        {directoryPreview.warnings.length ? <div className="cp-notice"><h4>载入前的提醒</h4><ul>{directoryPreview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}
        {!directoryPreview.canLoad ? <p className="gw-error" role="alert">这个目录目前没有可以载入的内容，请根据检查结果重新选择。</p> : null}
        <div className="gw-actions"><button type="button" className="gw-btn" disabled={busy || !directoryPreview.canLoad} onClick={() => void loadDirectory()}>{phase === 'directory-loading' ? '派蒙在载入资料…' : '确认载入'}</button><button type="button" className="gw-btn gw-btn-ghost" disabled={busy} onClick={() => { setDirectoryPreview(null); setDirectoryError(''); setDirectoryNotice('先取消啦，当前资料继续使用。'); directoryButton.current?.focus({ preventScroll: true }); }}>取消载入</button></div>
      </div> : null}
      {directoryResult ? <section className="cp-directory-result" aria-labelledby="resource-directory-result-title"><h3 id="resource-directory-result-title">本次载入结果</h3><p>已载入 {directoryResult.loadedCount} 个包 · 检查未通过 {directoryResult.failedCount} 个包</p>
        {directoryResult.raw ? <DirectoryRaw raw={directoryResult.raw} /> : null}
        {directoryResult.results.length ? <ul>{directoryResult.results.map((item, index) => <li key={item.file + ':' + index} data-resource-load-status={item.status}><strong>{item.package?.name || item.file}</strong>：{item.status === 'loaded' ? '已载入' : item.status === 'unchanged' ? '内容相同，继续使用' : item.status === 'skipped' ? '已跳过' : '未能载入'}{item.package ? ` · ${item.package.version}` : ''}{item.message ? <p className={item.status === 'error' ? 'gw-error' : 'gw-muted'}>{item.message}</p> : null}</li>)}</ul> : null}
        {directoryResult.warnings.length ? <div className="cp-notice"><ul>{directoryResult.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}
      </section> : null}
    </section>

    {preview ? <div ref={previewElement} tabIndex={-1} className="gw-panel cp-preview" aria-labelledby="content-preview-title">
      <div className="cp-heading"><h2 id="content-preview-title">确认导入内容包</h2><span className="cp-badge">{actionLabels[preview.action]}</span></div>
      <h3 className="cp-preview-name">{preview.package.name}</h3>
      {preview.package.description ? <p className="cp-description">{preview.package.description}</p> : null}
      <PackageFacts info={preview.package} />
      {preview.currentVersion ? <p className="cp-current-version">本机当前版本：{preview.currentVersion}</p> : null}
      {preview.package.kind === 'words' && preview.action === 'upgrade' ? <p className="gw-muted">词书更新后会按新版本的收词范围学习；已有学习记录会保留。</p> : null}
      <Dependencies dependencies={preview.package.dependencies} packages={packages} />
      {preview.warnings.length ? <div className="cp-notice cp-warnings"><h3>导入前看看这些提醒</h3><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}
      {preview.restartRequired ? <p className="cp-notice">这个内容包需要重新打开应用才会生效。导入完成后，请自行关闭并重新打开应用。</p>
        : preview.package.kind === 'reading' ? <p className="gw-muted">阅读包导入后即可在故事目录中使用。已有答卷会继续使用原来的版本。</p> : null}
      <div className="gw-actions">
        <button type="button" className="gw-btn" disabled={busy} onClick={() => void confirmImport()}>{phase === 'importing' ? '派蒙在整理背包…' : preview.action === 'unchanged' ? '确认，无需更新' : preview.action === 'upgrade' ? '确认更新' : '确认导入'}</button>
        <button type="button" className="gw-btn gw-btn-ghost" disabled={busy} onClick={() => { setPreview(null); setError(''); setNotice('先收起来啦，想导入时再叫派蒙。'); importButton.current?.focus({ preventScroll: true }); }}>取消导入</button>
        <button type="button" className="cp-text-button" disabled={busy} onClick={() => void choosePackage()}>重新选择文件</button>
      </div>
    </div> : null}

    <section className="cp-library" aria-labelledby="content-library-title">
      <div className="cp-heading"><h2 id="content-library-title">本机内容包</h2><label className="cp-filter"><span>查看类型</span><select className="gw-select" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
        <option value="all">全部类型</option>{Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label></div>
      {!loading || packages.length ? <p className="gw-muted cp-summary">使用中 {packages.filter(item => item.status === 'active').length} · 待重启 {pendingCount} · 未能加载 {packages.filter(item => item.status === 'error').length}</p> : null}
      {pendingCount > 0 ? <p className="cp-notice" role="status">有 {pendingCount} 个内容包等待生效。请在方便时关闭并重新打开应用，派蒙下次启动时会整理好它们。</p> : null}
      {loading ? <p className="gw-muted" role="status">派蒙在查看本机背包…</p> : null}
      {listError ? <div className="gw-error" role="alert"><p>暂时没能打开本机列表：{listError}</p><button type="button" className="gw-btn gw-btn-ghost" disabled={busy || loading} onClick={() => void refreshPackages()}>重新查看</button></div> : null}
      <div className="cp-package-list">{filtered.map((item, index) => <article key={item.id + ':' + item.version + ':' + item.status + ':' + index} className="gw-panel cp-package-card" data-content-package={item.id} data-content-status={item.status}>
        <div className="cp-heading"><h3>{item.name || item.id}</h3><span className={'cp-badge cp-status-' + item.status}>{statusLabels[item.status]}</span></div>
        <p className="gw-muted cp-package-origin">{item.builtIn ? '随应用提供' : '本机导入'}</p>
        {item.description ? <p className="cp-description">{item.description}</p> : null}
        <PackageFacts info={item} />
        <Dependencies dependencies={item.dependencies} packages={packages} />
        {item.message ? <p className={item.status === 'error' ? 'gw-error cp-package-message' : 'cp-notice cp-package-message'} role={item.status === 'error' ? 'alert' : undefined}>{item.message}</p> : item.status === 'error' ? <p className="gw-error" role="alert">这个内容包未能加载，请重新选择有效的本机文件。</p> : null}
      </article>)}</div>
      {!loading && !filtered.length && !listError ? <div className="gw-panel cp-empty"><p>{packages.length ? '这一类暂时没有内容包。换个类型看看，或者导入本机文件吧。' : '背包里还没有可用内容。准备好本机内容包，派蒙帮你检查后放进来。'}</p></div> : null}
    </section>

    <section className="cp-kinds" aria-labelledby="content-kinds-title"><h2 id="content-kinds-title">可以导入哪些内容</h2><p className="gw-muted">这里管理你已有的本机文件。导入前会检查内容、版本和需要的其他内容包。</p>
      <div className="cp-kind-grid">
        <article className="gw-panel"><h3>基础内容包</h3><p>提供本机词库和学习所需的基础资料。其他内容包需要它时，派蒙会核对对应版本。</p></article>
        <article className="gw-panel"><h3>素材包</h3><p>补充任务、角色语音、邀约或书籍等离线原文资料，供剧情浏览和例句学习使用。</p></article>
        <article className="gw-panel"><h3>词书包</h3><p>从本机已有词库选词，组成新的词书；释义和发音沿用现有词库。</p></article>
        <article className="gw-panel"><h3>阅读包</h3><p>带来阅读原文、题目和解析。导入后，就能到<Link to="/reading">故事目录</Link>里看看啦。</p></article>
      </div>
      <p className="gw-muted">单文件导入素材包和词书包后，需要重新打开应用；阅读包可以直接使用。通过“资源目录”检查并确认载入后，内容可在本次运行中使用。</p>
    </section>
  </section>;
}
