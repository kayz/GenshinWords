import { version as applicationVersion } from '../../../../package.json';
import { useTraveler } from '../components/TravelerProvider';
import fontLicense from '../assets/fonts/OFL.txt?raw';
import type { Coverage } from '../../../shared/models';
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

export default function About() {
  const traveler = useTraveler();
  const [coverage, setCoverage] = useState<Coverage[]>([]);
  useEffect(() => {
    void (async () => {
      if (!(await window.api.contentAvailable())) return;
      setCoverage(await window.api.listCoverage());
    })();
  }, []);
  return (
    <section>
      <h1
        className="gw-hero-title"
        style={{
          fontSize: '2rem',
        }}
      >
        关于
      </h1>
      <div className="gw-panel" style={{ marginBottom: '1.25rem' }}><h2>本机内容</h2><p className="gw-muted">程序版本 {applicationVersion}</p><p>想放进新的素材、词书或阅读吗？选好本机资源目录，或者导入内容包，派蒙帮你检查。</p><Link to="/content" className="gw-btn gw-btn-ghost">打开内容管理</Link></div>
      <div className="gw-panel gw-traveler-settings">
        <img src={traveler.avatar} alt={traveler.name + '的头像'} /><div><h2>旅行者 · {traveler.name}</h2><p className="gw-muted">想换个模样继续旅行？派蒙随时帮忙！</p></div>
        <button type="button" className="gw-btn gw-btn-ghost" onClick={traveler.openPicker}>重新选择空或荧</button>
      </div>
      <div
        className="gw-panel"
        style={{
          marginBottom: '1.25rem',
        }}
      >
        <p>
          <strong>GenshinWords</strong>
          是本地运行的非商业英语词汇学习工具，使用《原神》游戏内台词作为例句，帮助提高学习兴趣。
        </p>
        <p className="gw-muted">本软件不提供联网账号、不收集用户数据。学习进度仅保存在本机。</p>
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.1rem',
            color: 'var(--color-gold)',
          }}
        >
          版权声明
        </h2>
        <p>
          © All rights reserved by HoYoverse. Other properties belong to their respective owners.
        </p>
        <p className="gw-muted">
          《原神》及相关名称、角色、剧情、美术与音频均为米哈游 / HoYoverse
          的知识产权。本项目仅供个人学习使用，不得商用或再分发游戏素材。
        </p>
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.1rem',
            color: 'var(--color-gold)',
          }}
        >
          数据来源（构建期）
        </h2>
        <ul className="gw-muted">
          <li>文字主要来源：Project Amber (gi.yatta.moe)，包括任务、角色语音台词与游戏书籍正文</li>
          <li>图片：官方发布的人物立绘与活动图片，不使用游戏截图；关联来源保存在本地</li>
          <li>词书：qwerty-learner、maimemo-export（上海高考）、ECDICT</li>
          <li>英美发音：本地词典音频；少量缺项由 eSpeak NG 分别生成两种口音，并保留来源记录</li>
        </ul>
        <details className="gw-font-license">
          <summary>界面字体 · Noto Serif SC（SIL OFL 1.1）</summary>
          <p>标题字体随应用提供，可离线使用。Copyright © 2017–2024 Adobe.</p>
          <pre>{fontLicense}</pre>
        </details>
      </div>
      {coverage.length > 0 ? (
        <div className="gw-panel">
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.1rem',
              color: 'var(--color-gold)',
              marginTop: 0,
            }}
          >
            词书 × 原神台词覆盖
          </h2>
          <div
            className="gw-muted"
            style={{
              marginBottom: '0.75rem',
            }}
          >
            「未覆盖」= 词书中未能在已收录的本地任务与角色台词中匹配到例句的词数
          </div>
          <div
            style={{
              overflowX: 'auto',
            }}
          >
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.92rem',
              }}
            >
              <thead>
                <tr
                  className="gw-muted"
                  style={{
                    textAlign: 'left',
                  }}
                >
                  <th
                    style={{
                      padding: '0.35rem 0.4rem',
                    }}
                  >
                    词书
                  </th>
                  <th
                    style={{
                      padding: '0.35rem 0.4rem',
                    }}
                  >
                    总量
                  </th>
                  <th
                    style={{
                      padding: '0.35rem 0.4rem',
                    }}
                  >
                    已覆盖
                  </th>
                  <th
                    style={{
                      padding: '0.35rem 0.4rem',
                    }}
                  >
                    未覆盖
                  </th>
                  <th
                    style={{
                      padding: '0.35rem 0.4rem',
                    }}
                  >
                    覆盖率
                  </th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((r) => (
                  <tr
                    key={r.book_id}
                    style={{
                      borderTop: '1px solid rgba(232,220,196,0.1)',
                    }}
                  >
                    <td
                      style={{
                        padding: '0.4rem',
                      }}
                    >
                      {r.name_zh}
                    </td>
                    <td
                      style={{
                        padding: '0.4rem',
                      }}
                    >
                      {r.total}
                    </td>
                    <td
                      style={{
                        padding: '0.4rem',
                      }}
                    >
                      {r.covered}
                    </td>
                    <td
                      style={{
                        padding: '0.4rem',
                        color: 'var(--color-ember)',
                      }}
                    >
                      {r.uncovered}
                    </td>
                    <td
                      style={{
                        padding: '0.4rem',
                      }}
                      className="gw-stat"
                    >
                      {r.coverage_pct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
