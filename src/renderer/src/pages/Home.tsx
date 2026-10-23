import Primogem from '../components/Primogem';
import { normalizeStudyOrder, normalizeStudySize, STUDY_SIZES } from '../../../shared/study-settings';
import type { BookSummary, StudyStats, RewardSummary, StudyOrder, StudySize } from '../../../shared/models';
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import logo from '../assets/logo.png';
import { errorMessage, localDate } from '../lib/format';


export default function Home() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [bookId, setBookId] = useState('');
  const [stats, setStats] = useState<StudyStats | null>(null);
  const [rewards, setRewards] = useState<RewardSummary | null>(null);
  const [studySize, setStudySize] = useState<StudySize>('10');
  const [sizeSaving, setSizeSaving] = useState(false);
  const [order, setOrder] = useState<StudyOrder>('default');
  const [available, setAvailable] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const ok = await window.api.contentAvailable();
        if (!active) return;
        setAvailable(ok);
        if (!ok) {
          setReady(true);
          return;
        }
        const [list, saved, savedOrder, savedSize] = await Promise.all([
          window.api.listBooks(),
          window.api.getSetting('currentBook'),
          window.api.getSetting('studyOrder', 'default'),
          window.api.getSetting('studySize', '10'),
        ]);
        if (!active) return;
        const initial = list.find((b) => b.id === saved)?.id ?? list.find(b => /上海.*中考/.test(b.name_zh))?.id ?? list.find(b => /中考/.test(b.name_zh))?.id ?? list[0]?.id ?? '';
        if (initial && initial !== saved) await window.api.setSetting('currentBook', initial);
        const initialOrder = normalizeStudyOrder(savedOrder);
        if (savedOrder !== initialOrder) await window.api.setSetting('studyOrder', initialOrder);
        if (!active) return;
        setBooks(list);
        setOrder(initialOrder);
        setStudySize(normalizeStudySize(savedSize));
        setBookId(initial);
        setReady(true);
      } catch (cause) {
        if (active) {
          setError(errorMessage(cause));
          setReady(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!ready || !bookId) return;
    let active = true;
    void Promise.all([window.api.getStats(bookId), window.api.getRewards()]).then(
      ([nextStats, nextRewards]) => {
        if (active) {
          setStats(nextStats);
          setRewards(nextRewards);
        }
      },
      (cause) => {
        if (active) setError(errorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [bookId, ready]);
  async function selectBook(value: string) {
    setError('');
    try {
      await window.api.setSetting('currentBook', value);
      setStats(null);
      setRewards(null);
      setBookId(value);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function selectOrder(value: string) {
    setError('');
    try {
      await window.api.setSetting('studyOrder', value);
      setOrder(normalizeStudyOrder(value));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function selectSize(value: string) {
    if (sizeSaving) return;
    setSizeSaving(true); setError('');
    try { await window.api.setSetting('studySize', value); setStudySize(normalizeStudySize(value)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSizeSaving(false); }
  }
  if (!ready)
    return (
      <p className="gw-muted" role="status">
        正在打开旅行日志…
      </p>
    );
  if (!available)
    return (
      <section>
        <h1 className="gw-hero-title">GenshinWords</h1>
        <div className="gw-panel">
          <h2>本地内容包未找到</h2>
          <p>派蒙还没找到学习资料。到内容管理选择本机资源目录，或导入基础内容包吧。</p>
          <Link to="/content" className="gw-btn">打开内容管理</Link>
        </div>
      </section>
    );
  return (
    <section>
      <img src={logo} alt="派蒙读书" className="gw-home-logo" />
      <div className="gw-eyebrow">提瓦特 · 旅行日志</div>
      <h1 className="gw-hero-title">在故事里，记住单词。</h1>
      <p className="gw-hero-sub">从角色的台词，到书页里的冒险。今天记住的词，下一页再相逢。</p>
      {error ? (
        <p className="gw-error" role="alert">
          {error}
        </p>
      ) : null}
      {books.length === 0 ? (
        <div className="gw-panel"><p>本机还没有可用词书。到内容管理里放进基础内容包或适用的词书包，再回来选一本吧。</p><Link to="/content" className="gw-btn">打开内容管理</Link></div>
      ) : (
        <>
          <div className="gw-home-grid">
            <div className="gw-panel gw-book-settings">
              <label className="gw-label" htmlFor="book">
                当前词书
              </label>
              <select
                id="book"
                className="gw-select"
                value={bookId}
                onChange={(e) => void selectBook(e.target.value)}
              >
                {books.map((book) => (
                  <option key={book.id} value={book.id}>
                    {book.name_zh}（{book.word_count} 词）
                  </option>
                ))}
              </select>
              <p className="gw-muted">{books.find((book) => book.id === bookId)?.description}</p>
              <label className="gw-label" htmlFor="order">
                学习顺序
              </label>
              <select
                id="order"
                className="gw-select"
                value={order}
                onChange={(e) => void selectOrder(e.target.value)}
              >
                <option value="default">顺序</option>
                <option value="shuffle">乱序</option>
                <option value="by_chapter">原神</option>
              </select>
              <p className="gw-muted">派蒙先陪你复习到期的词，再按喜欢的顺序认识新词。</p>
              <label className="gw-label" htmlFor="study-size">本轮学习数量</label>
              <select id="study-size" className="gw-select" value={studySize} disabled={sizeSaving} onChange={event => void selectSize(event.target.value)}>
                {STUDY_SIZES.map(value => <option key={value} value={value}>{value === 'marathon' ? '马拉松 · 做到停为止' : value + ' 个词'}</option>)}
              </select>
              <p className="gw-muted">{studySize === 'marathon' ? '旅途不设终点，想休息时就点“结束本次”。到期的词，派蒙也会带回来。' : '本轮最多 ' + studySize + ' 个词，到期复习和新词一起计算。'}</p>
            </div>
            <Link to="/rewards" className="gw-panel gw-gem-summary">
              <Primogem className="gw-gem" sparkle />
              <div className="gw-eyebrow">全部学习内容累计</div>
              <div>
                <strong>{rewards?.total ?? '—'}</strong>
                <span className="gw-muted"> 原石</span>
              </div>
              <p className="gw-muted">
                单词自测 {rewards?.wordTotal ?? 0} · 阅读答题 {rewards?.readingTotal ?? 0}
                <br />
                每词与每道阅读题，分别领取一次。
              </p>
              <span className="gw-text-link">查看来源明细 →</span>
            </Link>
          </div>
          {stats ? (
            <div className="gw-study-stats">
              {[
                ['待复习', stats.due],
                ['可学新词', stats.newCount],
                ['学习中', stats.learning],
              ].map(([label, value]) => (
                <div key={label}>
                  <span className="gw-muted">{label}</span>
                  <strong className="gw-stat">{value}</strong>
                </div>
              ))}
            </div>
          ) : (
            <p className="gw-muted" role="status">
              正在读取学习进度…
            </p>
          )}
          <p className="gw-muted">剧情收藏词保存在独立的 <Link to="/collection">收藏词表</Link>，不计入当前词书。</p>
          <div className="gw-actions">
            <Link to="/review" className="gw-btn">
              开始复习
            </Link>
            <Link to="/practice" className="gw-btn gw-btn-ghost">
              单词自测
            </Link>
            <Link to="/reading" className="gw-btn gw-btn-ghost">
              分级阅读
            </Link>
            <Link to="/content" className="gw-btn gw-btn-ghost">内容管理</Link>
          </div>
        </>
      )}
    </section>
  );
}
