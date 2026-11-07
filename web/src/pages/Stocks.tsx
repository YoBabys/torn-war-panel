import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth'
import { stocksCatalog, tornGet } from '../lib/api'
import { fmtMoney, fmtPct, fmtShares } from '../lib/format'
import { getItem, keys, setItem } from '../lib/storage'
import {
  deployCashPlan,
  parseHoldings,
  portfolioSummary,
  rankOpportunities,
  reallocationPlan,
  type CatalogStock,
  type Holding,
} from '../lib/stocks'

function parseMoney(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, '').toLowerCase()
  if (!cleaned) return 0
  const m = cleaned.match(/^([\d.]+)([kmb])?$/)
  if (!m) return Number(cleaned) || 0
  const n = Number(m[1])
  if (m[2] === 'k') return n * 1_000
  if (m[2] === 'm') return n * 1_000_000
  if (m[2] === 'b') return n * 1_000_000_000
  return n
}

export function Stocks() {
  const { token, tornKey } = useAuth()
  const [catalog, setCatalog] = useState<CatalogStock[]>([])
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [apiMoney, setApiMoney] = useState<number | null>(null)
  const [liquidInput, setLiquidInput] = useState(() => getItem(keys.liquidOverride) || '')
  const [sellPassives, setSellPassives] = useState(
    () => getItem(keys.sellPassives) === '1'
  )
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  const liquid = useMemo(() => {
    if (liquidInput.trim()) return parseMoney(liquidInput)
    return apiMoney ?? 0
  }, [liquidInput, apiMoney])

  const refresh = useCallback(async () => {
    if (!token || !tornKey) return
    setLoading(true)
    setError('')
    try {
      const [cat, userStocks, moneyPayload] = await Promise.all([
        stocksCatalog(token, tornKey),
        tornGet('user/stocks', token, tornKey),
        tornGet('user/money', token, tornKey).catch(() => null),
      ])
      setCatalog(cat.stocks || [])
      setUpdatedAt(cat.at || Date.now())
      setHoldings(parseHoldings(userStocks))

      const money =
        moneyPayload?.money?.wallet ??
        moneyPayload?.money?.city_bank?.amount ??
        moneyPayload?.wallet ??
        moneyPayload?.money ??
        null
      if (money != null && Number.isFinite(Number(money))) {
        setApiMoney(Number(money))
      } else {
        // fallback: profile networth not ideal; leave null
        try {
          const profile = await tornGet('user', token, tornKey)
          const m2 = profile?.money?.wallet ?? profile?.profile?.money
          if (m2 != null) setApiMoney(Number(m2))
        } catch {
          /* manual input */
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [token, tornKey])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const summary = useMemo(() => portfolioSummary(catalog, holdings), [catalog, holdings])
  const opportunities = useMemo(
    () => rankOpportunities(catalog, holdings, liquid),
    [catalog, holdings, liquid]
  )
  const nextBuy = opportunities.find((o) => o.affordable) || opportunities[0] || null
  const deploy = useMemo(
    () => deployCashPlan(catalog, holdings, liquid),
    [catalog, holdings, liquid]
  )
  const realloc = useMemo(
    () => reallocationPlan(catalog, holdings, liquid, { sellPassives }),
    [catalog, holdings, liquid, sellPassives]
  )

  const passives = catalog.filter((s) => s.benefit.type === 'passive')

  return (
    <div>
      <h1 className="panel-title">STOCKS</h1>
      <p className="panel-sub">
        MV-based ROI advisor — what you own, what to buy next, and how to reallocate for more monthly
        income.
        {updatedAt ? (
          <span className="muted"> · catalog {new Date(updatedAt).toLocaleTimeString()}</span>
        ) : null}
      </p>

      <div className="toolbar">
        <label className="muted" htmlFor="liquid">
          Liquid cash
        </label>
        <input
          id="liquid"
          value={liquidInput}
          onChange={(e) => {
            setLiquidInput(e.target.value)
            setItem(keys.liquidOverride, e.target.value)
          }}
          placeholder={
            apiMoney != null ? `API: ${fmtMoney(apiMoney)} (override)` : 'e.g. 250m'
          }
          style={{ minWidth: 180 }}
        />
        <button className="btn small ghost" type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <label className="checkbox-row" style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={sellPassives}
            onChange={(e) => {
              setSellPassives(e.target.checked)
              setItem(keys.sellPassives, e.target.checked ? '1' : '0')
            }}
          />
          Treat passives as sellable capital
        </label>
      </div>

      {error ? <p className="err">{error}</p> : null}

      <div className="stat-row">
        <div className="stat">
          Liquid
          <strong>{fmtMoney(liquid)}</strong>
        </div>
        <div className="stat">
          Active capital
          <strong>{fmtMoney(summary.activeCapital)}</strong>
        </div>
        <div className="stat">
          Passive capital
          <strong>{fmtMoney(summary.passiveCapital)}</strong>
        </div>
        <div className="stat">
          Est. monthly from actives
          <strong>{fmtMoney(summary.monthlyIncome)}</strong>
        </div>
      </div>

      <div className="section">
        <h2>Advisor</h2>
        {nextBuy ? (
          <div className="advice">
            <strong>Next best:</strong> {nextBuy.stock.acronym} block #{nextBuy.nextIncrement} —{' '}
            {fmtShares(nextBuy.sharesNeeded)} shares ≈ {fmtMoney(nextBuy.costToComplete)} · ROI{' '}
            {fmtPct(nextBuy.annualRoi)} · +{fmtMoney(nextBuy.monthlyPayout)}/mo
            {!nextBuy.affordable ? (
              <span className="muted"> (not fully affordable with current liquid)</span>
            ) : null}
          </div>
        ) : (
          <p className="muted">No active blocks available.</p>
        )}

        {deploy.steps.length > 0 ? (
          <div className="advice">
            <strong>Deploy {fmtMoney(liquid)}:</strong> +{fmtMoney(deploy.monthlyGain)}/mo estimated
            <ol style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
              {deploy.steps.map((s, i) => (
                <li key={`${s.acronym}-${i}`}>
                  Buy {fmtShares(s.shares)} {s.acronym} ({fmtMoney(s.cost)}) → +
                  {fmtMoney(s.monthlyGain)}/mo · {fmtPct(s.annualRoi)} ROI
                </li>
              ))}
            </ol>
            {deploy.leftover > 0 ? (
              <p className="muted" style={{ margin: '0.4rem 0 0' }}>
                Leftover {fmtMoney(deploy.leftover)}
              </p>
            ) : null}
          </div>
        ) : null}

        {realloc.moves.length > 0 ? (
          <div className="advice">
            <strong>Reallocation:</strong> currently {fmtMoney(realloc.currentMonthly)}/mo → target{' '}
            {fmtMoney(realloc.optimizedMonthly)}/mo (
            <span style={{ color: realloc.deltaMonthly >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
              {realloc.deltaMonthly >= 0 ? '+' : ''}
              {fmtMoney(realloc.deltaMonthly)}/mo
            </span>
            )
            <ol style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
              {realloc.moves.map((m, i) => (
                <li key={i}>
                  {m.note}
                  {m.sellShares > 0
                    ? ` · sell ${fmtShares(m.sellShares)} ${m.sellAcronym} (${fmtMoney(m.sellProceeds)})`
                    : ''}
                  {` · buy ${fmtShares(m.buyShares)} ${m.buyAcronym} (${fmtMoney(m.buyCost)})`}
                  {` · ${m.monthlyDelta >= 0 ? '+' : ''}${fmtMoney(m.monthlyDelta)}/mo`}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="muted">No reallocation edge found vs your current active blocks.</p>
        )}
      </div>

      <div className="section">
        <h2>Your positions</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Stock</th>
                <th>Shares</th>
                <th>Capital</th>
                <th>$/mo</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {summary.positions.map((p) => (
                <tr key={p.stock.stockId}>
                  <td>
                    {p.stock.acronym} <span className="muted">{p.stock.name}</span>
                  </td>
                  <td>{fmtShares(p.holding.totalShares)}</td>
                  <td>{fmtMoney(p.capital)}</td>
                  <td>{p.monthly ? fmtMoney(p.monthly) : '—'}</td>
                  <td>{p.stock.benefit.type}</td>
                </tr>
              ))}
              {!summary.positions.length ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No holdings returned from Torn.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <h2>Active ROI ranking (next block)</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Stock</th>
                <th>Next block</th>
                <th>Cost</th>
                <th>$/mo</th>
                <th>Annual ROI</th>
                <th>Benefit</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((o, i) => (
                <tr key={o.stock.stockId}>
                  <td>{i + 1}</td>
                  <td>
                    {o.stock.acronym}
                    {o.affordable ? <span className="pill ok">afford</span> : null}
                  </td>
                  <td>
                    #{o.nextIncrement} · {fmtShares(o.sharesNeeded)} sh
                  </td>
                  <td>{fmtMoney(o.costToComplete)}</td>
                  <td>{fmtMoney(o.monthlyPayout)}</td>
                  <td>{fmtPct(o.annualRoi)}</td>
                  <td className="muted">{o.stock.benefit.description || o.stock.benefit.valueSource}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <h2>Passive / utility</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Kept out of cash ROI ranking unless you enable sellable passives.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Stock</th>
                <th>Price</th>
                <th>Shares for perk</th>
                <th>Benefit</th>
                <th>Owned</th>
              </tr>
            </thead>
            <tbody>
              {passives.map((s) => {
                const h = holdings.find((x) => x.stockId === s.stockId)
                return (
                  <tr key={s.stockId}>
                    <td>
                      {s.acronym} <span className="muted">{s.name}</span>
                    </td>
                    <td>{fmtMoney(s.price, 2)}</td>
                    <td>{fmtShares(s.benefit.requirement)}</td>
                    <td className="muted">{s.benefit.description}</td>
                    <td>{h ? fmtShares(h.totalShares) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
