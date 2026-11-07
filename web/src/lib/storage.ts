const PREFIX = 't7t_'

export const keys = {
  tornKey: `${PREFIX}torn_key`,
  tsKey: `${PREFIX}ts_key`,
  token: `${PREFIX}token`,
  session: `${PREFIX}session`,
  apiBase: `${PREFIX}api_base`,
  liquidOverride: `${PREFIX}liquid_override`,
  sellPassives: `${PREFIX}sell_passives`,
  ffCache: `${PREFIX}ff_cache`,
} as const

export function getItem(key: string): string {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

export function setItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

export function removeItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

export function getJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function setJson(key: string, value: unknown) {
  setItem(key, JSON.stringify(value))
}
