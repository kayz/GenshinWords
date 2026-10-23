import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ReadingPackageInfo, ReadingPackagePreview } from '../../../shared/reading-package-management';

interface Props { onImported: () => void; onBusyChange: (busy: boolean) => void }

function packageError(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) return '阅读包没有导入成功，请重新选择文件。';
  return error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
}

const actionLabels = { install: '新增阅读包', upgrade: '更新已有阅读包', unchanged: '已安装相同版本，无需更新' };

/** Import is offered in the directory, after the reading page has saved its draft. */
export default function ReadingPackageManager({ onImported, onBusyChange }: Props) {
  const [packages, setPackages] = useState<ReadingPackageInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [preview, setPreview] = useState<ReadingPackagePreview | null>(null);
  const [phase, setPhase] = useState<'idle' | 'checking' | 'importing'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const operationLock = useRef(false);
  const listRequest = useRef(0);
  const previewElement = useRef<HTMLDivElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  const busy = phase !== 'idle';
  const activePackages = packages.filter(item => item.status === 'active');
  const failedPackages = packages.filter(item => item.status === 'error');

  async function refreshPackages() {
    const request = ++listRequest.current;
    setLoading(true); setListError('');
    try {
      const next = await window.api.listReadingPackages();
      if (mounted.current && request === listRequest.current) setPackages(next);
    } catch (reason) {
      if (mounted.current && request === listRequest.current) setListError(packageError(reason));
    } finally {
      if (mounted.current && request === listRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refreshPackages();
    return () => { mounted.current = false; listRequest.current += 1; onBusyChange(false); };
  }, []);

  async function choosePackage() {
    if (operationLock.current) return;
    operationLock.current = true;
    setPhase('checking'); onBusyChange(true); setError(''); setNotice('');
    try {
      const next = await window.api.previewReadingPackageImport();
      if (!mounted.current) return;
      if (!next) { setNotice('取消选择啦，咱们接着看故事。'); return; }
      setPreview(next);
      requestAnimationFrame(() => {
        previewElement.current?.scrollIntoView({ block: 'start' });
        previewElement.current?.focus({ preventScroll: true });
      });
    } catch (reason) {
      if (mounted.current) { setPreview(null); setError(packageError(reason)); }
    } finally {
      operationLock.current = false;
      if (mounted.current) { setPhase('idle'); onBusyChange(false); }
    }
  }

  async function confirmImport() {
    if (!preview || operationLock.current) return;
    operationLock.current = true;
    setPhase('importing'); onBusyChange(true); setError(''); setNotice('');
    try {
      const result = await window.api.importReadingPackage(preview.token);
      if (!mounted.current) return;
      setPreview(null);
      setNotice(result.action === 'unchanged'
        ? `「${result.package.name}」${result.package.version} 已在书架上，无需更新。`
        : `「${result.package.name}」${result.package.version} ${result.action === 'upgraded' ? '更新' : '导入'}成功，派蒙把故事目录整理好啦！`);
      onImported();
      await refreshPackages();
      requestAnimationFrame(() => importButton.current?.focus({ preventScroll: true }));
    } catch (reason) {
      if (mounted.current) setError(packageError(reason));
    } finally {
      operationLock.current = false;
      if (mounted.current) { setPhase('idle'); onBusyChange(false); }
    }
  }

  return <section className="gw-panel rd-packages" aria-labelledby="reading-packages-title" aria-busy={busy}>
    <div className="rd-packages-heading">
      <div><h2 id="reading-packages-title">本机阅读包</h2><p className="gw-muted">有新的故事吗？选一个 .gwreading 文件，派蒙先检查，再请你确认。全程离线。</p><p><Link to="/content">素材、词书和阅读的统一内容管理 →</Link></p></div>
      <button ref={importButton} type="button" className="gw-btn" disabled={busy} onClick={() => void choosePackage()}>
        {phase === 'checking' ? '派蒙在检查阅读包…' : '导入阅读包'}
      </button>
    </div>
    {loading ? <p className="gw-muted" role="status">派蒙看看本机书架…</p> : null}
    {listError ? <div className="gw-error" role="alert"><p>阅读包列表暂时没能打开：{listError}</p><button type="button" className="gw-btn gw-btn-ghost" disabled={busy || loading} onClick={() => void refreshPackages()}>重新查看阅读包</button></div> : null}
    {activePackages.length ? <details className="rd-package-list"><summary>{activePackages.length} 个可用阅读包</summary><ul>{activePackages.map(item => <li key={item.id}>
      <div><strong>{item.name}</strong><span className="rd-package-tag">{item.builtIn ? '内置' : '已导入'}</span></div>
      <p className="gw-muted">版本 {item.version} · {item.unitCount} 篇 · {item.questionCount} 题</p>
    </li>)}</ul></details> : !loading && !listError ? <p className="gw-muted">书架里还没有可用阅读包，导入后就能读故事啦。</p> : null}
    {failedPackages.map(item => <div className="gw-error rd-package-load-error" key={item.id} role="alert">
      <p><strong>{item.name || item.id}</strong>（版本 {item.version}）未能加载</p><p>{item.message || '阅读包无法读取，请导入有效的阅读包。'}</p>
    </div>)}
    {preview ? <div ref={previewElement} tabIndex={-1} className="rd-package-preview" aria-labelledby="reading-package-preview-title">
      <h3 id="reading-package-preview-title">确认导入阅读包</h3>
      <p>派蒙检查好这个文件啦，看看是不是你要放上书架的故事。</p>
      <dl className="rd-package-facts">
        <div><dt>名称</dt><dd>{preview.package.name}</dd></div>
        <div><dt>版本</dt><dd>{preview.package.version}</dd></div>
        <div><dt>内容</dt><dd>{preview.package.unitCount} 篇阅读 · {preview.package.questionCount} 题</dd></div>
        <div><dt>导入动作</dt><dd>{actionLabels[preview.action]}{preview.currentVersion ? `（当前版本 ${preview.currentVersion}）` : ''}</dd></div>
      </dl>
      {preview.action === 'upgrade' ? <p className="gw-muted">已有答卷会继续使用原来的版本；新一轮阅读使用更新后的内容。</p> : null}
      <div className="gw-actions">
        <button type="button" className="gw-btn" disabled={busy} onClick={() => void confirmImport()}>{phase === 'importing' ? '派蒙在整理书架…' : preview.action === 'unchanged' ? '确认，无需更新' : '确认导入'}</button>
        <button type="button" className="gw-btn gw-btn-ghost" disabled={busy} onClick={() => { setPreview(null); setError(''); setNotice('先放回背包啦，咱们接着看故事。'); importButton.current?.focus({ preventScroll: true }); }}>取消导入</button>
        <button type="button" className="rd-text-button" disabled={busy} onClick={() => void choosePackage()}>重新选择文件</button>
      </div>
    </div> : null}
    {error ? <div className="gw-error rd-package-operation-error" role="alert"><p>阅读包未能导入：{error}</p><p>派蒙还留着当前目录，再选一个文件试试吧。</p></div> : null}
    {notice ? <p className="rd-notice" role="status">{notice}</p> : null}
  </section>;
}
