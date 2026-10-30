import { Suspense, lazy } from "react";
import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { Spinner } from "./components/ui";
import { PlanLimitNotice } from "./components/PlanLimitNotice";

const Landing = lazy(() => import("./pages/Landing"));
const PublicMap = lazy(() => import("./pages/PublicMap"));
const Login = lazy(() => import("./pages/auth/Login"));
const Register = lazy(() => import("./pages/auth/Register"));
const ForgotPassword = lazy(() => import("./pages/auth/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/auth/ResetPassword"));
const VerifyEmail = lazy(() => import("./pages/auth/VerifyEmail"));
const Invite = lazy(() => import("./pages/auth/Invite"));
const Shell = lazy(() => import("./pages/app/Shell"));
const Overview = lazy(() => import("./pages/app/Overview"));
const LiveMap = lazy(() => import("./pages/app/LiveMap"));
const Assets = lazy(() => import("./pages/app/Assets"));
const AssetDetail = lazy(() => import("./pages/app/AssetDetail"));
const Alerts = lazy(() => import("./pages/app/Alerts"));
const AlertDetail = lazy(() => import("./pages/app/AlertDetail"));
const Integrations = lazy(() => import("./pages/app/Integrations"));
const DataPage = lazy(() => import("./pages/app/Data"));
const Profile = lazy(() => import("./pages/app/settings/Profile"));
const Organization = lazy(() => import("./pages/app/settings/Organization"));
const Team = lazy(() => import("./pages/app/settings/Team"));
const ApiKeys = lazy(() => import("./pages/app/settings/ApiKeys"));
const Notifications = lazy(() => import("./pages/app/settings/Notifications"));
const Admin = lazy(() => import("./pages/app/Admin"));
const NotFound = lazy(() => import("./pages/NotFound"));

export function PageSpinner() {
  return (
    <div className="page-loading">
      <Spinner size="lg" />
    </div>
  );
}

function RequireApp({ children }: { children: ReactNode }) {
  const { loading, canUseApp } = useAuth();
  const loc = useLocation();
  if (loading) return <PageSpinner />;
  if (!canUseApp) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`} replace />;
  return <>{children}</>;
}

function RequireSuperuser({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  if (!me?.user?.is_superuser) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/live" element={<PublicMap />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/invite/:token" element={<Invite />} />
        <Route
          path="/app"
          element={
            <RequireApp>
              <Shell />
            </RequireApp>
          }
        >
          <Route index element={<Overview />} />
          <Route path="map" element={<LiveMap />} />
          <Route path="assets" element={<Assets />} />
          <Route path="assets/:id" element={<AssetDetail />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="alerts/:id" element={<AlertDetail />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="data" element={<DataPage />} />
          <Route path="settings" element={<Navigate to="/app/settings/profile" replace />} />
          <Route path="settings/profile" element={<Profile />} />
          <Route path="settings/organization" element={<Organization />} />
          <Route path="settings/team" element={<Team />} />
          <Route path="settings/api-keys" element={<ApiKeys />} />
          <Route path="settings/notifications" element={<Notifications />} />
          <Route
            path="admin"
            element={
              <RequireSuperuser>
                <Admin />
              </RequireSuperuser>
            }
          />
          <Route path="*" element={<NotFound inApp />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
      <PlanLimitNotice />
    </Suspense>
  );
}
