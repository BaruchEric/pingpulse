import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { useAuth } from "@/lib/hooks";
import { Layout } from "@/components/Layout";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { Login } from "@/pages/Login";
import { Overview } from "@/pages/Overview";
import { Clients } from "@/pages/Clients";
import { ClientDetail } from "@/pages/ClientDetail";
import { Alerts } from "@/pages/Alerts";
import { Settings } from "@/pages/Settings";
import { ControlPanel } from "@/pages/ControlPanel";

export function App() {
  const { authed, login, logout } = useAuth();

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/login"
          element={
            authed ? <Navigate to="/" replace /> : <Login onLogin={login} />
          }
        />
        <Route
          element={
            <ProtectedRoute authed={authed}>
              <Layout onLogout={logout} />
            </ProtectedRoute>
          }
        >
          <Route index element={<Overview />} />
          <Route path="clients" element={<Clients />} />
          <Route path="client/:id" element={<ClientDetail />} />
          <Route path="client/:id/control" element={<ControlPanel />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
