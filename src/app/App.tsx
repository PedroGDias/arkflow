import { Navigate, Route, Routes } from 'react-router-dom'
import { LoginPage } from '../pages/LoginPage'
import { DashboardPage } from '../pages/DashboardPage'
import { ClientPickerPage } from '../pages/ClientPickerPage'
import { AdminPage } from '../pages/AdminPage'
import { ProtectedRoute } from './ProtectedRoute'
import { AuthCallbackPage } from '../pages/AuthCallbackPage'
import { useAuth } from '../context/AuthContext'

function RoleHome() {
  const { isInternal, accessibleClientIds } = useAuth()

  // Internal users: full picker.
  if (isInternal) return <ClientPickerPage />

  // Client users with a single accessible client: jump straight in.
  if (accessibleClientIds && accessibleClientIds.length === 1) {
    return <Navigate to={`/client/${accessibleClientIds[0]}`} replace />
  }

  // Multiple accessible clients: still use the picker (RLS filters the list).
  if (accessibleClientIds && accessibleClientIds.length > 1) {
    return <ClientPickerPage />
  }

  // Authenticated but no clients yet — show the picker so they see an empty state.
  return <ClientPickerPage />
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <RoleHome />
          </ProtectedRoute>
        }
      />
      <Route
        path="/client/:clientId"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <ProtectedRoute requireRole="internal">
            <AdminPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
