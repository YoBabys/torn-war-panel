import { getItem, keys } from './storage'

export function apiBase(): string {
  const custom = getItem(keys.apiBase).trim()
  if (custom) return custom.replace(/\/+$/, '')
  // Dev: vite proxies /api → worker. Prod: set VITE_API_BASE or Settings.
  return import.meta.env.VITE_API_BASE?.replace(/\/+$/, '') || '/api'
}

export type SessionInfo = {
  token: string
  userId: number
  name: string
  factionId: number
  factionName: string | null
  expiresIn: number
}

async function parseJson(res: Response) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok || (data && typeof data === 'object' && 'error' in data && data.error)) {
    const msg =
      typeof data?.error === 'string'
        ? data.error
        : data?.error?.error || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data
}

export async function authLogin(tornKey: string): Promise<SessionInfo> {
  const res = await fetch(`${apiBase()}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tornKey }),
  })
  return parseJson(res)
}

export async function apiFetch(
  path: string,
  opts: {
    method?: string
    body?: unknown
    token: string
    tornKey?: string
  }
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
  }
  if (opts.tornKey) headers['X-Torn-Key'] = opts.tornKey
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${apiBase()}${path.startsWith('/') ? path : `/${path}`}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  return parseJson(res)
}

export async function tornGet(path: string, token: string, tornKey: string) {
  const clean = path.replace(/^\//, '')
  return apiFetch(`/torn/${clean}`, { token, tornKey })
}

export async function stocksCatalog(token: string, tornKey: string) {
  return apiFetch('/stocks/catalog', { token, tornKey })
}

export async function tornStatsGet(
  path: string,
  token: string,
  tsKey: string
) {
  const clean = path.replace(/^\//, '')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-TornStats-Key': tsKey,
  }
  const res = await fetch(`${apiBase()}/tornstats/${clean}`, { headers })
  return parseJson(res)
}

export async function getSyncState(token: string) {
  return apiFetch('/state', { token })
}

export async function putDib(
  token: string,
  targetId: number,
  body?: { force?: boolean; note?: string }
) {
  return apiFetch(`/dibs/${targetId}`, { method: 'PUT', token, body: body || {} })
}

export async function deleteDib(token: string, targetId: number) {
  return apiFetch(`/dibs/${targetId}`, { method: 'DELETE', token })
}

export async function putAssist(
  token: string,
  body: { targetId: number; targetName?: string }
) {
  return apiFetch('/assists', { method: 'PUT', token, body })
}

export async function deleteAssist(token: string, attackerId: number) {
  return apiFetch(`/assists/${attackerId}`, { method: 'DELETE', token })
}
