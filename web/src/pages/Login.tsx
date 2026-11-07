import { useState, type FormEvent } from 'react'
import { useAuth } from '../lib/auth'
import { getItem, keys, setItem } from '../lib/storage'

export function Login() {
  const { login } = useAuth()
  const [tornKey, setTornKey] = useState(() => getItem(keys.tornKey))
  const [tsKey, setTsKey] = useState(() => getItem(keys.tsKey))
  const [apiBase, setApiBase] = useState(() => getItem(keys.apiBase))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (apiBase.trim()) setItem(keys.apiBase, apiBase.trim())
      else setItem(keys.apiBase, '')
      await login(tornKey, tsKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-panel" onSubmit={onSubmit}>
        <div className="brand">
          THE 7TH TERMINAL
          <span>FACTION OPS</span>
        </div>
        <p className="tagline">
          Shared war dibs and a stocks advisor for your faction. Sign in with a Torn API key from a
          licensed faction.
        </p>

        <div className="field">
          <label htmlFor="tornKey">Torn API key</label>
          <input
            id="tornKey"
            type="password"
            autoComplete="off"
            value={tornKey}
            onChange={(e) => setTornKey(e.target.value)}
            placeholder="Full or Limited key"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="tsKey">TornStats key (optional)</label>
          <input
            id="tsKey"
            type="password"
            autoComplete="off"
            value={tsKey}
            onChange={(e) => setTsKey(e.target.value)}
            placeholder="For enemy spies on War"
          />
        </div>

        <div className="field">
          <label htmlFor="apiBase">API base (optional)</label>
          <input
            id="apiBase"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder="Leave blank for /api (dev proxy) or set Worker URL"
          />
        </div>

        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Connecting…' : 'Enter terminal'}
        </button>
        {error ? <p className="err">{error}</p> : null}
      </form>
    </div>
  )
}
