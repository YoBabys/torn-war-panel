import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { authLogin, type SessionInfo } from './api'
import { getItem, getJson, keys, removeItem, setItem, setJson } from './storage'

type AuthState = {
  tornKey: string
  tsKey: string
  token: string
  user: SessionInfo | null
  ready: boolean
}

type AuthContextValue = AuthState & {
  login: (tornKey: string, tsKey?: string) => Promise<void>
  logout: () => void
  setTsKey: (key: string) => void
  setTornKeyLocal: (key: string) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

function loadInitial(): AuthState {
  const tornKey = getItem(keys.tornKey)
  const tsKey = getItem(keys.tsKey)
  const token = getItem(keys.token)
  const user = getJson<SessionInfo | null>(keys.session, null)
  return {
    tornKey,
    tsKey,
    token,
    user: token && user ? user : null,
    ready: true,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(loadInitial)

  const login = useCallback(async (tornKey: string, tsKey = '') => {
    const key = tornKey.trim()
    if (!key) throw new Error('Torn API key is required')
    const session = await authLogin(key)
    setItem(keys.tornKey, key)
    setItem(keys.tsKey, tsKey.trim())
    setItem(keys.token, session.token)
    setJson(keys.session, session)
    setState({
      tornKey: key,
      tsKey: tsKey.trim(),
      token: session.token,
      user: session,
      ready: true,
    })
  }, [])

  const logout = useCallback(() => {
    removeItem(keys.token)
    removeItem(keys.session)
    setState((s) => ({ ...s, token: '', user: null }))
  }, [])

  const setTsKey = useCallback((key: string) => {
    setItem(keys.tsKey, key.trim())
    setState((s) => ({ ...s, tsKey: key.trim() }))
  }, [])

  const setTornKeyLocal = useCallback((key: string) => {
    setItem(keys.tornKey, key.trim())
    setState((s) => ({ ...s, tornKey: key.trim() }))
  }, [])

  const value = useMemo(
    () => ({ ...state, login, logout, setTsKey, setTornKeyLocal }),
    [state, login, logout, setTsKey, setTornKeyLocal]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
