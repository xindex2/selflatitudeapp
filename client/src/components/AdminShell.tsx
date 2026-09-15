import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Icons, Logo } from './ui';
import './shell.css';

export default function AdminShell() {
  const { user } = useAuth();
  const isSuper = user?.role === 'superadmin';
  const cls = ({ isActive }: { isActive: boolean }) => `nav-item ${isActive ? 'active' : ''}`;
  return (
    <div className="admin-shell">
      <nav className="admin-nav" aria-label="Administration">
        <div className="brand"><Logo height={34} /></div>
        <NavLink to="/admin" end className={cls}><Icons.admin /> Overview</NavLink>
        <div className="section-label">Owner</div>
        <NavLink to="/admin/companion" className={cls}><Icons.sparkle /> Companion</NavLink>
        <NavLink to="/admin/usage" className={cls}><Icons.bolt /> Usage limits</NavLink>
        <NavLink to="/admin/openai" className={cls}><Icons.key /> OpenAI connection</NavLink>
        <NavLink to="/admin/plans" className={cls}><Icons.file /> Plans</NavLink>
        <div className="section-label">Super Admin</div>
        <NavLink to="/admin/users" className={cls}><Icons.users /> Users</NavLink>
        <NavLink to="/admin/privacy-requests" className={cls}><Icons.shield /> Privacy requests</NavLink>
        <NavLink to="/admin/audit" className={cls}><Icons.clock /> Audit history</NavLink>
        <NavLink to="/admin/jvzoo" className={cls}><Icons.download /> JVZoo &amp; payments</NavLink>
        <NavLink to="/admin/email" className={cls}><Icons.send /> Email</NavLink>
        <NavLink to="/admin/signin" className={cls}><Icons.lock /> Sign-in policy</NavLink>
        <div className="grow" />
        <NavLink to="/" className="nav-item"><Icons.chevronLeft /> Back to Companion</NavLink>
        {!isSuper ? <div className="meta" style={{ padding: '8px 12px' }}>Super Admin sections require a Super Admin account with MFA.</div> : null}
      </nav>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
