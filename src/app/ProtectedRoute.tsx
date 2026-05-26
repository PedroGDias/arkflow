import { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

type Props = {
  children: ReactNode
  /** When set, restricts the route to a specific role. */
  requireRole?: 'internal'
}

export function ProtectedRoute({ children, requireRole }: Props) {
  const { session, initializing, profile, isLockedOut, isInternal } = useAuth()
  const loc = useLocation()

  if (initializing) return null
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  if (isLockedOut) return <Navigate to="/login" replace state={{ locked: true }} />
  if (requireRole === 'internal' && !isInternal) return <Navigate to="/" replace />
  // profile may still be loading on the very first render after sign-in;
  // we let the children render anyway — the child will refetch with RLS.
  void profile
  return children
}
