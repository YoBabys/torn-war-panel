import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../lib/auth'
import {
  deleteAssist,
  deleteDib,
  getSyncState,
  putAssist,
  putDib,
  tornGet,
  tornStatsGet,
} from '../lib/api'
import { attackUrl, fmtCountdown } from '../lib/format'
import { getJson, keys, setJson } from '../lib/storage'
import {
  buildRetals,
  memberBucket,
  normalizeMembers,
  parseAttacksPayload,
  parseWar,
  revLabel,
  sortMembers,
  statusLight,
  type Assist,
  type Dib,
  type FfEntry,
  type Member,
  type Retal,
  type WarInfo,
} from '../lib/war'

type Filter = 'all' | 'okay' | 'hosp' | 'jail' | 'travel'

export function War() {
  const { token, tornKey, tsKey, user } = useAuth()
  const [war, setWar] = useState<WarInfo | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [chain, setChain] = useState<{ current?: number; timeout?: number; max?: number } | null>(
    null
  )
  const [chainEndsAt, setChainEndsAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState('hosp')
  const [dibs, setDibs] = useState<Record<string, Dib>>({})
  const [assists, setAssists] = useState<Record<string, Assist>>({})
  const [retals, setRetals] = useState<Retal[]>([])
  const [ff, setFf] = useState<Record<string, FfEntry>>(() => getJson(keys.ffCache, {}))
  const [spies, setSpies] = useState<Record<string, { total?: number }>>({})
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<number | null>(null)
  const myId = user?.userId ?? 0
  const audioRef = useRef<AudioContext | null>(null)
  const alert45 = useRef(false)
  const alert90 = useRef(false)

  const remaining = Math.max(0, (chainEndsAt - now) / 1000)

  const beep = useCallback((freq: number, repeats: number) => {
    try {
      if (!audioRef.current) {
        audioRef.current = new AudioContext()
      }
      const ctx = audioRef.current
      if (ctx.state === 'suspended') void ctx.resume()
      let t = ctx.currentTime
      for (let i = 0; i < repeats; i++) {
        const osc = ctx.createOscillator()
        const g = ctx.createGain()
        osc.frequency.value = freq
        g.gain.value = 0.07
        osc.connect(g)
        g.connect(ctx.destination)
        osc.start(t)
        osc.stop(t + 0.15)
        t += 0.28
      }
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (remaining > 90) alert90.current = false
    if (remaining > 45) alert45.current = false
    if (remaining > 0 && remaining <= 90 && !alert90.current) {
      alert90.current = true
      beep(660, 1)
    }
    if (remaining > 0 && remaining <= 45 && !alert45.current) {
      alert45.current = true
      beep(990, 3)
    }
  }, [remaining, beep])

  const loadChain = useCallback(async () => {
    if (!token || !tornKey) return
    const started = Date.now()
    const data = await tornGet('faction/chain', token, tornKey)
    const received = Date.now()
    const rtt = Math.max(0, received - started)
    const c = data.chain || null
    setChain(c)
    const timeoutSec = Number(c?.timeout || 0)
    setChainEndsAt(received + timeoutSec * 1000 - rtt)
  }, [token, tornKey])

  const loadRoster = useCallback(async () => {
    if (!token || !tornKey || !user) return
    const wars = await tornGet('faction/wars', token, tornKey)
    const w = parseWar(wars, user.factionId)
    setWar(w)
    if (!w) {
      setMembers([])
      return
    }
    const membersData = await tornGet(`faction/${w.enemyId}/members`, token, tornKey)
    setMembers(normalizeMembers(membersData.members))

    if (tsKey) {
      try {
        const data = await tornStatsGet(`spy/faction/${w.enemyId}`, token, tsKey)
        const spiesOut: Record<string, { total?: number }> = {}
        const membersSpy = data?.faction?.members || data?.spies || {}
        for (const [id, entry] of Object.entries(
          membersSpy as Record<string, { spy?: { total?: number }; total?: number }>
        )) {
          const spy = entry.spy || entry
          if (spy) spiesOut[id] = { total: spy.total }
        }
        setSpies(spiesOut)
      } catch {
        /* optional */
      }
    }
  }, [token, tornKey, user, tsKey])

  const loadAttacks = useCallback(async () => {
    if (!token || !tornKey || !user) return
    const nowSec = Math.floor(Date.now() / 1000)
    const from = nowSec - 60 * 60
    let outgoing: ReturnType<typeof parseAttacksPayload> = []
    let incoming: ReturnType<typeof parseAttacksPayload> = []
    try {
      const outData = await tornGet(
        `user/attacks?filters=outgoing&from=${from}&limit=100`,
        token,
        tornKey
      )
      outgoing = parseAttacksPayload(outData)
    } catch {
      /* ignore */
    }
    try {
      const inData = await tornGet(
        `user/attacks?filters=incoming&from=${from}&limit=100`,
        token,
        tornKey
      )
      incoming = parseAttacksPayload(inData)
    } catch {
      /* ignore */
    }

    setFf((prevFf) => {
      const nextFf = { ...prevFf }
      for (const a of outgoing) {
        if (!a.defenderId || !Number.isFinite(a.ff)) continue
        const id = String(a.defenderId)
        const prev = nextFf[id]
        if (!prev || a.ended >= (prev.at || 0)) {
          nextFf[id] = { ff: a.ff, at: a.ended, result: a.result, name: a.defenderName }
        }
      }
      setJson(keys.ffCache, nextFf)
      return nextFf
    })

    const enemyIds = new Set(members.map((m) => m.id))
    setRetals(
      buildRetals([...outgoing, ...incoming], {
        myId: user.userId,
        myFactionId: user.factionId,
        enemyId: war?.enemyId ?? null,
        enemyMemberIds: enemyIds,
        nowSec,
      })
    )
  }, [token, tornKey, user, members, war])

  const loadSync = useCallback(async () => {
    if (!token) return
    const state = await getSyncState(token)
    setDibs(state.dibs || {})
    setAssists(state.assists || {})
  }, [token])

  useEffect(() => {
    let cancelled = false
    async function tick() {
      try {
        setError('')
        await loadChain()
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void tick()
    const id = window.setInterval(tick, 5000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [loadChain])

  useEffect(() => {
    let cancelled = false
    async function tick() {
      try {
        await loadRoster()
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void tick()
    const id = window.setInterval(tick, 20000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [loadRoster])

  useEffect(() => {
    void loadAttacks()
    const id = window.setInterval(() => void loadAttacks(), 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: refresh when roster/war settles
  }, [token, tornKey, war?.enemyId, members.length])

  useEffect(() => {
    void loadSync()
    const id = window.setInterval(() => void loadSync(), 4000)
    return () => clearInterval(id)
  }, [loadSync])

  const nowSec = Math.floor(now / 1000)
  const filtered = useMemo(() => {
    let list = members
    if (filter !== 'all') list = list.filter((m) => memberBucket(m, nowSec) === filter)
    return sortMembers(list, sort, nowSec, ff)
  }, [members, filter, sort, nowSec, ff])

  const assistList = Object.values(assists)

  async function claim(targetId: number, force = false) {
    if (!token) return
    setBusyId(targetId)
    try {
      const res = await putDib(token, targetId, { force })
      if (res.conflict && !force) {
        const who = res.existing?.claimerName || 'someone'
        if (window.confirm(`Already claimed by ${who}. Force claim?`)) {
          const forced = await putDib(token, targetId, { force: true })
          setDibs(forced.dibs || {})
          setAssists(forced.assists || {})
        }
      } else {
        setDibs(res.dibs || {})
        setAssists(res.assists || {})
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  async function release(targetId: number) {
    if (!token) return
    setBusyId(targetId)
    try {
      const res = await deleteDib(token, targetId)
      setDibs(res.dibs || {})
      setAssists(res.assists || {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  async function requestAssist(m: Member) {
    if (!token) return
    try {
      const res = await putAssist(token, { targetId: m.id, targetName: m.name })
      setDibs(res.dibs || {})
      setAssists(res.assists || {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function clearMyAssist() {
    if (!token || !user) return
    try {
      const res = await deleteAssist(token, user.userId)
      setDibs(res.dibs || {})
      setAssists(res.assists || {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const chainClass =
    remaining > 0 && remaining <= 45 ? 'hot' : remaining > 0 && remaining <= 90 ? 'warn' : ''

  return (
    <div>
      <h1 className="panel-title">WAR</h1>
      <p className="panel-sub">
        {war
          ? `vs ${war.enemyName} · score ${war.myScore ?? '—'} / ${war.enemyScore ?? '—'}`
          : 'No ranked war detected'}
      </p>

      <div className="stat-row">
        <div className="stat chain">
          Chain timer
          <strong className={chainClass}>{fmtCountdown(remaining)}</strong>
        </div>
        <div className="stat">
          Chain
          <strong>
            {chain?.current ?? 0}
            {chain?.max ? ` / ${chain.max}` : ''}
          </strong>
        </div>
        <div className="stat">
          Enemy online-ish
          <strong>
            {members.filter((m) => statusLight(m) !== 'offline').length}/{members.length}
          </strong>
        </div>
      </div>

      {error ? <p className="err">{error}</p> : null}

      {assistList.length > 0 ? (
        <div className="section">
          <h2>Assists</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Attacker</th>
                  <th>Target</th>
                  <th>Age</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {assistList.map((a) => (
                  <tr key={a.attackerId}>
                    <td>{a.attackerName}</td>
                    <td>
                      <a href={attackUrl(a.targetId)} target="_blank" rel="noreferrer">
                        {a.targetName || a.targetId}
                      </a>
                    </td>
                    <td>{fmtCountdown((now - a.createdAt) / 1000)}</td>
                    <td>
                      {a.attackerId === myId ? (
                        <button className="btn small ghost" type="button" onClick={clearMyAssist}>
                          Clear
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {retals.length > 0 ? (
        <div className="section">
          <h2>Retals</h2>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Attacker</th>
                  <th>Left</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {retals.map((r) => (
                  <tr key={r.attackerId}>
                    <td>{r.attackerName}</td>
                    <td>{fmtCountdown(Math.max(0, r.ended + 300 - nowSec))}</td>
                    <td>
                      <a className="btn small" href={attackUrl(r.attackerId)} target="_blank" rel="noreferrer">
                        Attack
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="toolbar">
        {(['all', 'okay', 'hosp', 'jail', 'travel'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            className={`btn small ${filter === f ? '' : 'ghost'}`}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="hosp">Sort: hosp soonest</option>
          <option value="name">Sort: name</option>
          <option value="level">Sort: level</option>
          <option value="ff">Sort: FF</option>
        </select>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Member</th>
              <th>Status</th>
              <th>FF</th>
              <th>Spy</th>
              <th>Dibs</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((m) => {
              const bucket = memberBucket(m, nowSec)
              const until = Number(m.status?.until || 0)
              const dib = dibs[String(m.id)]
              const light = statusLight(m)
              const rev = revLabel(m)
              const ffVal = ff[String(m.id)]?.ff
              const spy = spies[String(m.id)]?.total
              return (
                <tr key={m.id}>
                  <td>
                    <span className={`light ${light}`} />
                    <a href={attackUrl(m.id)} target="_blank" rel="noreferrer">
                      {m.name}
                    </a>
                    <span className="muted"> L{m.level}</span>
                    {rev ? <span className={`pill ${rev === 'Rev-On' ? 'ok' : 'danger'}`}>{rev}</span> : null}
                  </td>
                  <td>
                    {bucket}
                    {until > nowSec ? (
                      <span className="pill warn">{fmtCountdown(until - nowSec)}</span>
                    ) : null}
                  </td>
                  <td>{ffVal != null ? ffVal.toFixed(2) : '—'}</td>
                  <td>{spy != null ? Math.round(spy).toLocaleString() : '—'}</td>
                  <td>
                    {dib ? (
                      <span className={dib.claimerId === myId ? 'pill ok' : 'pill warn'}>
                        {dib.claimerName}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!dib || dib.claimerId === myId ? (
                      dib?.claimerId === myId ? (
                        <button
                          className="btn small ghost"
                          type="button"
                          disabled={busyId === m.id}
                          onClick={() => void release(m.id)}
                        >
                          Release
                        </button>
                      ) : (
                        <button
                          className="btn small"
                          type="button"
                          disabled={busyId === m.id}
                          onClick={() => void claim(m.id)}
                        >
                          Dibs
                        </button>
                      )
                    ) : (
                      <button
                        className="btn small danger"
                        type="button"
                        disabled={busyId === m.id}
                        onClick={() => void claim(m.id, true)}
                      >
                        Force
                      </button>
                    )}{' '}
                    <button className="btn small ghost" type="button" onClick={() => void requestAssist(m)}>
                      Assist
                    </button>
                  </td>
                </tr>
              )
            })}
            {!filtered.length ? (
              <tr>
                <td colSpan={6} className="muted">
                  No members match this filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  )
}
