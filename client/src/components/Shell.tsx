import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Avatar, Icons, Logo, Menu } from './ui';
import ConversationSidebar from './ConversationSidebar';
import './shell.css';

/**
 * Student layout: left sidebar (brand, nav, conversation list, usage, account),
 * main content on the right. Sidebar collapses to a drawer below 900px.
 */
export default function Shell() {
  const { user, usage, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setOpen(false), [loc.pathname]);

  const isAdmin = user?.role === 'owner' || user?.role === 'superadmin';
  const onChat = loc.pathname === '/' || loc.pathname.startsWith('/chat');

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="shell-topbar">
        <button className="btn icon ghost" aria-label="Open menu" onClick={() => setOpen(true)}><Icons.menu /></button>
        <Logo height={30} />
        <Link to="/profile" aria-label="Your profile" style={{ display: 'inline-flex' }}>
          <Avatar name={user?.name ?? ''} email={user?.email} src={user?.avatarUrl ?? null} size={30} />
        </Link>
      </header>

      {open ? <div className="drawer-backdrop" onClick={() => setOpen(false)} /> : null}
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Navigation">
        <div className="sidebar-brand">
          <Logo height={38} />
          <button className="btn icon ghost sidebar-close" aria-label="Close menu" onClick={() => setOpen(false)}><Icons.x /></button>
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/" className={() => `nav-item ${onChat ? 'active' : ''}`} end><Icons.chat /> Companion</NavLink>
          <NavLink to="/memory" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Icons.memory /> Memory</NavLink>
          <NavLink to="/journal" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Icons.journal /> Journal</NavLink>
        </nav>

        {onChat ? <ConversationSidebar /> : <div className="grow" />}

        <div className="sidebar-footer">
          {usage ? <UsageMini usage={usage} /> : null}
          <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Icons.settings /> Settings</NavLink>
          <NavLink to="/privacy" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Icons.shield /> Privacy & data</NavLink>
          <NavLink to="/help" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}><Icons.info /> Help</NavLink>
          {isAdmin ? <NavLink to="/admin" className="nav-item"><Icons.admin /> Administration</NavLink> : null}

          <Menu
            align="left"
            trigger={
              <button className="account-button" aria-label="Account menu" aria-haspopup="menu">
                <Avatar name={user?.name ?? ''} email={user?.email} src={user?.avatarUrl ?? null} size={34} />
                <span className="who">
                  <span className="n">{user?.name}</span>
                  <span className="e">{user?.email}</span>
                </span>
                <Icons.chevronDown size={16} />
              </button>
            }
          >
            <div className="account-menu-inner">
              <Link to="/profile"><Icons.users size={16} /> Profile</Link>
              <Link to="/settings"><Icons.settings size={16} /> Settings</Link>
              <Link to="/help"><Icons.info size={16} /> Help</Link>
              <div className="sep" />
              <button onClick={() => logout().then(() => nav('/login'))}><Icons.logout size={16} /> Sign out</button>
            </div>
          </Menu>
        </div>
      </aside>

      <main id="main" className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}

function UsageMini({ usage }: { usage: NonNullable<ReturnType<typeof useAuth>['usage']> }) {
  const pct = usage.repliesLimit ? Math.min(100, Math.round((usage.repliesUsed / usage.repliesLimit) * 100)) : 0;
  const own = usage.paymentSource === 'customer_key';
  const warn = usage.warning !== 'none' && !own;
  return (
    <NavLink to="/settings#usage" className="usage-mini" aria-label="Usage">
      <div className="row between small">
        <span style={{ fontWeight: 500 }}>{own ? 'Using your API key' : 'Included usage'}</span>
        {!own ? <span className={warn ? 'chip warning' : 'meta'}>{usage.repliesRemaining} left</span> : <span className="chip info">•••• {usage.customerKey?.last4}</span>}
      </div>
      {!own ? (
        <div className="usage-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${pct}%` }} className={warn ? 'warn' : ''} />
        </div>
      ) : null}
      <div className="meta">Resets {new Date(usage.periodEnd + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
    </NavLink>
  );
}
