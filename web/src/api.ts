import { t } from './i18n'

export class ApiError extends Error {
  status: number
  constructor(status: number, msg: string) {
    super(msg)
    this.status = status
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch('/api' + url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json', 'X-USS': '1' } : { 'X-USS': '1' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (r.status === 401 && !url.startsWith('/auth')) {
    window.dispatchEvent(new Event('uss:unauthorized'))
  }
  const text = await r.text()
  const data = text ? JSON.parse(text) : null
  if (!r.ok) throw new ApiError(r.status, t(data?.error ?? r.statusText))
  return data as T
}

/** Uploads a file as the raw request body. */
async function upload<T>(url: string, file: Blob): Promise<T> {
  const r = await fetch('/api' + url, { method: 'PUT', credentials: 'same-origin', headers: { 'X-USS': '1', 'Content-Type': file.type || 'application/octet-stream' }, body: file })
  const text = await r.text()
  const data = text ? JSON.parse(text) : null
  if (!r.ok) throw new ApiError(r.status, t(data?.error ?? r.statusText))
  return data as T
}

export const api = {
  upload,
  get: <T,>(u: string) => req<T>('GET', u),
  post: <T,>(u: string, b?: unknown) => req<T>('POST', u, b ?? {}),
  put: <T,>(u: string, b: unknown) => req<T>('PUT', u, b),
  del: <T,>(u: string) => req<T>('DELETE', u),
}

export interface User {
  id: number
  username: string
  email: string
  name: string
  role: 'admin' | 'viewer'
  provider: string
  disabled: boolean
  created_at: number
  last_login: number
  language: string
  language_manual: boolean
}

export type BrandingAssetName = 'logo_light' | 'logo_dark' | 'favicon'
export interface Branding {
  company_name: string
  version: string
  assets: Partial<Record<BrandingAssetName, boolean>>
}

export const brandingUrl = (b: Branding, a: BrandingAssetName) => `/api/branding/${a}?v=${b.version}`

export interface LogRow {
  ts: string
  received: string
  source_ip: string
  site: string
  hostname: string
  device_model: string
  device_mac: string
  device_version: string
  facility: number
  severity: number
  app: string
  category: string
  event_type: string
  action: string
  rule: string
  src_ip: string
  dst_ip: string
  src_port: number
  dst_port: number
  proto: string
  in_if: string
  out_if: string
  client_mac: string
  client_name: string
  client_ip: string
  ssid: string
  message: string
  raw: string
  fields: Record<string, string>
}

export interface TopItem { key: string; count: number }
export interface Bucket { t: string; key: string; count: number }

export interface Category {
  id: number
  name: string
  description: string
  color: string
  icon: string
  query: string
  pinned: boolean
  sort: number
}
