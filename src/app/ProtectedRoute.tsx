import { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, initializing } = useAuth()
  const loc = useLocation()

  if (initializing) return null
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  return children
}

