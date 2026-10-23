import { NavLink, Outlet } from 'react-router-dom';
import logo from '../assets/logo.png';
import { useTraveler } from './TravelerProvider';

export default function Layout() {
  const traveler = useTraveler();
  return (
    <div className="gw-shell">
      <nav className="gw-nav">
        <NavLink to="/" className="gw-brand" end={true}>
          <span className="gw-brand-badge"><img src={logo} alt="派蒙读书" className="gw-brand-logo" /></span>
          GenshinWords
        </NavLink>
        <NavLink to="/review" className={({ isActive }) => (isActive ? 'active' : '')}>
          复习
        </NavLink>
        <NavLink to="/browse" className={({ isActive }) => (isActive ? 'active' : '')}>
          剧情
        </NavLink>
        <NavLink to="/collection" className={({ isActive }) => (isActive ? 'active' : '')}>收藏词表</NavLink>
        <NavLink to="/practice" className={({ isActive }) => (isActive ? 'active' : '')}>
          单词自测
        </NavLink>
        <NavLink to="/reading" className={({ isActive }) => (isActive ? 'active' : '')}>分级阅读</NavLink>
        <NavLink to="/rewards" className={({ isActive }) => (isActive ? 'active' : '')}>
          原石
        </NavLink>
        <NavLink to="/content" className={({ isActive }) => (isActive ? 'active' : '')}>内容管理</NavLink>
        <NavLink to="/about" className={({ isActive }) => (isActive ? 'active' : '')}>
          关于
        </NavLink>
        <button type="button" className="gw-traveler-toggle" onClick={traveler.openPicker} aria-label="重新选择旅行者" title="重新选择空或荧">
          <img src={traveler.avatar} alt="" data-traveler-avatar={traveler.choice} /><span>{traveler.name} · 切换</span>
        </button>
      </nav>
      <main className="gw-main">
        <Outlet />
      </main>
    </div>
  );
}
