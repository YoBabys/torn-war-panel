import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { Login } from './pages/Login'
import { Settings } from './pages/Settings'
import { Stocks } from './pages/Stocks'
import { War } from './pages/War'

function Shell() {
  const { user, ready, logout } = useAuth()

  if (!ready) return null
  if (!user) return <Login />

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          THE 7TH TERMINAL
          <span>ONLINE</span>
        </div>
        <nav className="nav">
          <NavLink to="/war" className={({ isActive }) => (isActive ? 'active' : '')}>
            War
          </NavLink>
          <NavLink to="/stocks" className={({ isActive }) => (isActive ? 'active' : '')}>
            Stocks
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            Settings
          </NavLink>
        </nav>
        <div className="user-chip">
          <strong>{user.name}</strong>
          <div>
            {user.factionName || `Faction ${user.factionId}`}
            {' · '}
            <button
              type="button"
              className="btn small ghost"
              style={{ padding: '0 0.25rem' }}
              onClick={logout}
            >
              Out
            </button>
          </div>
        </div>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/war" replace />} />
          <Route path="/war" element={<War />} />
          <Route path="/stocks" element={<Stocks />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/war" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
