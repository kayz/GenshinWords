import type { StudyStats, RewardSummary } from '../../../shared/models';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CollectionEntry } from '../../../shared/collection';
import { COLLECTION_ID } from '../../../shared/collection';
import { errorMessage, localDate } from '../lib/format';

export default function Collection() {
  const [entries, setEntries] = useState<CollectionEntry[]>([]);
  const [stats, setStats] = useState<StudyStats | null>(null);
  const [rewards, setRewards] = useState<RewardSummary | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [round, setRound] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [removed, setRemoved] = useState<CollectionEntry | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([window.api.listCollection(), window.api.getStats(COLLECTION_ID), window.api.getRewards()])
      .then(([list, summary, gems]) => {
        if (!active) return;
        setEntries(list); setStats(summary); setRewards(gems);
        setPage(previous => Math.min(previous, Math.max(0, Math.ceil(list.length / 20) - 1)));
      }).catch(cause => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [round]);
  async function remove(entry: CollectionEntry) {
    setPending(true); setError('');
    try {
      await window.api.removeCollectedWord(entry.word.id);
      setRemoved(entry); setRound(value => value + 1);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  async function undo() {
    if (!removed) return;
    setPending(true); setError('');
    try {
      await window.api.restoreCollectedWord(removed.word.id);
      setRemoved(null); setRound(value => value + 1);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(false); }
  }
  const filtered = entries.filter(entry => (entry.word.lemma + ' ' + entry.word.translation).toLowerCase().includes(query.trim().toLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  return (
    <section>
      <div className="gw-eyebrow">提瓦特 · 收藏词表</div>
      <h1 className="gw-hero-title">记住相遇的那一句。</h1>
      <p className="gw-hero-sub">旅途中遇到的词，派蒙都帮你收好啦。再见到它时，就用当初的那句话练练手吧！</p>
      <div className="gw-actions">
        <Link to="/review?scope=collection" className="gw-btn">复习收藏词</Link>
        <Link to="/practice?scope=collection" className="gw-btn gw-btn-ghost">原句测试</Link>
        <Link to="/rewards?scope=collection" className="gw-btn gw-btn-ghost">收藏奖励明细</Link>
        <Link to="/browse" className="gw-btn gw-btn-ghost">去剧情收录</Link>
      </div>
      {stats ? <p className="gw-muted">共 {stats.total} 词 · 待复习 {stats.due} · 新词 {stats.newCount} · 已获 {rewards?.history.filter(entry => entry.source === 'word' && entry.bookId === COLLECTION_ID).length ?? 0} 原石</p> : null}
      {stats && stats.pendingSource > 0 ? <p className="gw-muted">有 {stats.pendingSource} 个旧收藏未保存来源句，仍可复习。在剧情或阅读原文里再点一次这个词，补上相遇的那句话吧。</p> : null}
      {removed ? <div className="gw-panel" role="status">
        已移除 {removed.word.lemma}，原句与历史进度已保留。
        <button type="button" className="gw-btn gw-btn-ghost" disabled={pending || loading} onClick={() => void undo()}>撤销移除</button>
      </div> : null}
      {error ? <div className="gw-error" role="alert">{error} <button type="button" className="gw-btn gw-btn-ghost" onClick={() => { setError(''); setRound(value => value + 1); }}>重试</button></div> : null}
      <label className="gw-label" htmlFor="collection-search">查找收藏词</label>
      <input id="collection-search" className="gw-input gw-reward-search" value={query} placeholder="单词或中文释义"
        onChange={event => { setQuery(event.target.value); setPage(0); }} />
      {loading ? <p role="status" className="gw-muted">正在读取收藏词表…</p> : <>
        {filtered.slice(page * 20, (page + 1) * 20).map(entry => <article className="gw-panel gw-collection-entry" key={entry.word.id}>
          <h2>{entry.word.lemma}</h2>
          <p>{entry.word.translation}</p>
          <p className="gw-muted">{entry.reviewed ? '已复习' : '尚未复习'} · 收录于 {localDate(entry.createdAt)}</p>
          {entry.source ? <div>
            <blockquote className="gw-example"><p>{entry.source.text}</p></blockquote>
            <p className="gw-muted">{[entry.source.speaker, entry.source.sourceTitle, entry.source.title].filter(Boolean).join(' · ')}</p>
            <Link to={entry.source.origin === 'reading' ? '/reading?unitId=' + encodeURIComponent(entry.source.unitId) + '&paragraph=' + entry.source.paragraph + (entry.source.attemptId ? '&attemptId=' + encodeURIComponent(entry.source.attemptId) : '') : '/browse?chapterId=' + entry.source.chapterId + '&questId=' + entry.source.questId + '&lineId=' + entry.source.lineId}>{entry.source.origin === 'reading' ? '回到故事原文' : '回到来源台词'}</Link>
          </div> : <p className="gw-muted">待补来源：旧版本没留下那句话，在剧情或阅读原文里再点一次这个词吧。</p>}
          <div className="gw-actions">
            {entry.reviewed && entry.source ? <Link className="gw-btn gw-btn-ghost" to={'/practice?scope=collection&wordId=' + entry.word.id}>测试这个词</Link> : null}
            <button type="button" className="gw-btn gw-btn-ghost" disabled={pending} onClick={() => void remove(entry)}>移出收藏</button>
          </div>
        </article>)}
        {!filtered.length ? <p className="gw-muted">{entries.length ? '没有匹配的收藏词。' : '词表还是空的呢。在剧情或阅读的解答区点点单词，派蒙就能帮你收好啦。'}</p> : null}
        {pages > 1 ? <div className="gw-pagination">
          <button type="button" className="gw-btn gw-btn-ghost" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</button>
          <span className="gw-muted">{page + 1} / {pages}</span>
          <button type="button" className="gw-btn gw-btn-ghost" disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>下一页</button>
        </div> : null}
      </>}
    </section>
  );
}
