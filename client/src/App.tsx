import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Spinner } from './components/ui';
import Shell from './components/Shell';
import AdminShell from './components/AdminShell';
import { LoginPage, RegisterPage, ForgotPage, ResetPage, OneTimePage } from './pages/AuthPages';
import OnboardingPage from './pages/OnboardingPage';
import MfaVerifyPage from './pages/MfaVerifyPage';
import ChatPage from './pages/ChatPage';
import MemoryPage from './pages/MemoryPage';
import JournalPage from './pages/JournalPage';
import SettingsPage from './pages/SettingsPage';
import PrivacyPage from './pages/PrivacyPage';
import ProfilePage from './pages/ProfilePage';
import HelpPage from './pages/HelpPage';
import { lazy, Suspense } from 'react';
// Admin pages are code-split: students never download them.
const AdminOverview = lazy(() => import('./pages/admin/AdminOverview'));
const AdminCompanion = lazy(() => import('./pages/admin/AdminCompanion'));
const AdminUsers = lazy(() => import('./pages/admin/AdminUsers'));
const AdminUserDetail = lazy(() => import('./pages/admin/AdminUserDetail'));
const AdminAudit = lazy(() => import('./pages/admin/AdminAudit'));
const AdminPrivacyRequests = lazy(() => import('./pages/admin/AdminPrivacyRequests'));
const AdminUsageSettings = lazy(() => import('./pages/admin/AdminUsageSettings'));
const AdminOpenAI = lazy(() => import('./pages/admin/AdminOpenAI'));
const AdminPlans = lazy(() => import('./pages/admin/AdminPlans'));
const AdminJvzoo = lazy(() => import('./pages/admin/AdminJvzoo'));
const AdminEmail = lazy(() => import('./pages/admin/AdminEmail'));
const AdminSignIn = lazy(() => import('./pages/admin/AdminSignIn'));
import { TermsPage, PrivacyNoticePage } from './pages/StaticPages';

function Loading() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <Spinner />
    </div>
  );
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  // A password alone is not enough when the account uses two-step verification: the server
  // refuses every other request until the code is entered, so send them there.
  if (user.mfaRequired && !user.mfaVerified) return <Navigate to="/mfa" replace state={{ from: loc.pathname }} />;
  if (!user.onboardingCompleted && loc.pathname !== '/welcome') return <Navigate to="/welcome" replace />;
  return children;
}

function RequireAdmin({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mfaRequired && !user.mfaVerified) return <Navigate to="/mfa" replace />;
  if (user.role !== 'owner' && user.role !== 'superadmin') return <Navigate to="/" replace />;
  return <Suspense fallback={<Loading />}>{children}</Suspense>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPage />} />
      <Route path="/reset-password" element={<ResetPage />} />
      <Route path="/one-time" element={<OneTimePage />} />
      <Route path="/mfa" element={<MfaVerifyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/privacy-notice" element={<PrivacyNoticePage />} />
      <Route path="/welcome" element={<RequireAuth><OnboardingPage /></RequireAuth>} />

      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route path="/" element={<ChatPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/journal" element={<JournalPage />} />
        <Route path="/journal/:id" element={<JournalPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/help" element={<HelpPage />} />
      </Route>

      <Route path="/admin" element={<RequireAdmin><AdminShell /></RequireAdmin>}>
        <Route index element={<AdminOverview />} />
        <Route path="companion" element={<AdminCompanion />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="users/:id" element={<AdminUserDetail />} />
        <Route path="audit" element={<AdminAudit />} />
        <Route path="privacy-requests" element={<AdminPrivacyRequests />} />
        <Route path="usage" element={<AdminUsageSettings />} />
        <Route path="openai" element={<AdminOpenAI />} />
        <Route path="plans" element={<AdminPlans />} />
        <Route path="jvzoo" element={<AdminJvzoo />} />
        <Route path="email" element={<AdminEmail />} />
        <Route path="signin" element={<AdminSignIn />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
