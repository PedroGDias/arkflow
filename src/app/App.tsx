import { Navigate, Route, Routes } from 'react-router-dom'
import { LoginPage } from '../pages/LoginPage'
import { DashboardPage } from '../pages/DashboardPage'
import { ClientPickerPage } from '../pages/ClientPickerPage'
import { ProtectedRoute } from './ProtectedRoute'
import { AuthCallbackPage } from '../pages/AuthCallbackPage'

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <ClientPickerPage />
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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

