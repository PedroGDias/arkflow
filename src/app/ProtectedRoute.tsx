import { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

type Props = {
  children: ReactNode
  /** When set, restricts the route to a specific role. */
  requireRole?: 'internal'
}

export function ProtectedRoute({ children, requireRole }: Props) {
  const { session, initializing, profileChecked, isLockedOut, isInternal } = useAuth()
  const loc = useLocation()

  if (initializing) return null
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname }} />

  // Wait for the profile load to resolve before deciding lockout/role.
  // Otherwise the user briefly looks "locked out" between session-established
  // and profile-loaded, and we'd bounce them back to /login in a loop.
  if (!profileChecked) return null

  if (isLockedOut) return <Navigate to="/login" replace />
  if (requireRole === 'internal' && !isInternal) return <Navigate to="/" replace />
  return children
}
