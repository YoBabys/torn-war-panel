import { useState, type FormEvent } from 'react'
import { useAuth } from '../lib/auth'
import { getItem, keys, setItem } from '../lib/storage'

export function Settings() {
  const { user, tornKey, tsKey, setTsKey, setTornKeyLocal, logout, login } = useAuth()
  const [key, setKey] = useState(tornKey)
  const [ts, setTs] = useState(tsKey)
  const [apiBase, setApiBase] = useState(() => getItem(keys.apiBase))
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSave(e: FormEvent) {
    e.preventDefault()
    setMsg('')
    setErr('')
    setBusy(true)
    try {
      setItem(keys.apiBase, apiBase.trim())
      setTornKeyLocal(key)
      setTsKey(ts)
      if (key.trim() && key.trim() !== tornKey) {
        await login(key, ts)
      }
      setMsg('Saved.')
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h1 className="panel-title">SETTINGS</h1>
      <p className="panel-sub">
        Signed in as <strong>{user?.name}</strong> · faction {user?.factionName || user?.factionId}
      </p>

      <form onSubmit={onSave} style={{ maxWidth: 480 }}>
        <div className="field">
          <label htmlFor="tornKey">Torn API key</label>
          <input
            id="tornKey"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="tsKey">TornStats key</label>
          <input
            id="tsKey"
            type="password"
            value={ts}
            onChange={(e) => setTs(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="apiBase">Worker API base URL</label>
          <input
            id="apiBase"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder="https://seventh-terminal.…workers.dev"
          />
        </div>
        <div className="toolbar">
          <button className="btn" type="submit" disabled={busy}>
            Save
          </button>
          <button className="btn ghost" type="button" onClick={logout}>
            Log out
          </button>
        </div>
        {msg ? <p className="muted">{msg}</p> : null}
        {err ? <p className="err">{err}</p> : null}
      </form>

      <div className="section" style={{ marginTop: '2rem' }}>
        <h2>License admin</h2>
        <p className="muted">
          Faction allowlist is managed on the Worker at <code>/admin</code> (owner Torn IDs only).
        </p>
      </div>
    </div>
  )
}
