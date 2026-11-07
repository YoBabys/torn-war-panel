export function fmtMoney(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}b`
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}m`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`
  return `${sign}$${abs.toFixed(digits)}`
}

export function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

export function fmtShares(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString()
}

export function fmtCountdown(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const s = Math.floor(sec)
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const mm = m % 60
    return `${h}:${String(mm).padStart(2, '0')}:${String(r).padStart(2, '0')}`
  }
  return `${m}:${String(r).padStart(2, '0')}`
}

export function attackUrl(userId: number): string {
  return `https://www.torn.com/loader.php?sid=attack&user2ID=${userId}`
}

export function profileUrl(userId: number): string {
  return `https://www.torn.com/profiles.php?XID=${userId}`
}
