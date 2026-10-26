import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Info, TriangleAlert, Search, LayoutDashboard } from 'lucide-react'
import { cx } from '../components/ui'
import { t } from '../i18n'
import type { MockRow, MockSpec } from './Mockup'

/** Fills {placeholders} in a translated sentence with elements. */
export function rich(text: string, parts: Record<string, ReactNode>) {
  return text.split(/(\{\w+\})/).map((p, i) => {
    const k = p.match(/^\{(\w+)\}$/)?.[1]
    return k && k in parts ? <span key={i}>{parts[k]}</span> : p
  })
}

/** A UniFi menu path such as Settings › CyberSecure › Traffic Logging. */
export function Path({ p }: { p: string }) {
  const parts = p.split('>').map((s) => s.trim())
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5 rounded-md bg-[var(--panel-2)] px-1.5 py-0.5 align-middle text-[0.85em] font-medium ring-1 ring-[var(--border)]">
      {parts.map((s, i) => <span key={i} className="inline-flex items-center gap-0.5">{i > 0 && <ChevronRight className="size-3 text-muted" />}{s}</span>)}
    </span>
  )
}

/** A label exactly as UniFi shows it. */
export const UI = ({ children }: { children: ReactNode }) => <span className="font-semibold text-[var(--text)]">{children}</span>

export function Steps({ children }: { children: ReactNode }) {
  return <ol className="space-y-3">{children}</ol>
}

export function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-sm leading-relaxed">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-amber-400 text-[11px] font-bold text-slate-900">{n}</span>
      <div className="min-w-0 flex-1 text-muted [&_b]:text-[var(--text)]">{children}</div>
    </li>
  )
}

export function Note({ warn, title, children }: { warn?: boolean; title?: string; children: ReactNode }) {
  return (
    <div className={cx('flex gap-3 rounded-xl px-4 py-3 text-sm ring-1', warn ? 'bg-amber-500/10 ring-amber-500/30' : 'bg-indigo-500/10 ring-indigo-500/25')}>
      {warn ? <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" /> : <Info className="mt-0.5 size-4 shrink-0 text-indigo-400" />}
      <div className="min-w-0 space-y-1 text-muted">
        {title && <div className="font-medium text-[var(--text)]">{title}</div>}
        {children}
      </div>
    </div>
  )
}

/** An example of a raw log line, so the reader can recognise it. */
export function Sample({ lines }: { lines: string[] }) {
  return (
    <pre className="scroll-thin overflow-x-auto rounded-xl bg-[var(--panel-2)] p-3 font-mono text-[11px] leading-relaxed text-muted ring-1 ring-[var(--border)]">
      {lines.join('\n')}
    </pre>
  )
}

/** Links that show whether the data arrives. */
export function Verify({ query, dashboard }: { query: string; dashboard?: string }) {
  const cls = 'inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 ring-[var(--border)] transition hover:bg-[var(--panel-2)] hover:ring-indigo-400/60 [&_svg]:size-4 [&_svg]:text-indigo-400'
  return (
    <div className="flex flex-wrap gap-2">
      <Link to={'/logs?' + new URLSearchParams({ q: query, preset: '24h' })} className={cls}><Search />{t('Search the logs')}<code className="font-mono text-xs text-muted">{query}</code></Link>
      {dashboard && <Link to={dashboard} className={cls}><LayoutDashboard />{t('Open the dashboard')}</Link>}
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  )
}

/** Where this server receives syslog, as the UniFi form wants it. */
export const serverAddress = () => window.location.hostname || 'syslog.example.com'

export const settingsMenu = ['WiFi', 'Networks', 'Internet', 'VPN', 'Routing', 'Policy Engine', 'CyberSecure', 'Control Plane', 'System']

/** The CyberSecure › Traffic Logging page with some parts highlighted. */
export function trafficLogging(o: { menu?: number; tab?: number; mode?: number; contents?: number; server?: number; debug?: number; flow?: number; netconsole?: number; marks?: Record<string, number>; apply?: number } = {}): MockSpec {
  const m = o.marks ?? {}
  const rows: MockRow[] = [
    { kind: 'select', label: 'Flow Logging', value: 'Blocked Only', mark: o.flow },
    { kind: 'segmented', label: 'Activity Logging (Syslog)', options: ['Off', 'SIEM Server'], value: 'SIEM Server', mark: o.mode },
    { kind: 'checks', label: 'Contents', mark: o.contents, options: [
      { label: 'Gateway', on: true, mark: m['Gateway'] },
      { label: 'Security Detections', on: true, mark: m['Security Detections'] },
      { label: 'Firewall Default Policy', on: true, mark: m['Firewall Default Policy'] },
      { label: 'VPN', on: true, mark: m['VPN'] },
      { label: 'Updates', on: true, mark: m['Updates'] },
      { label: 'Critical', on: true, mark: m['Critical'] },
    ] },
    { kind: 'checks', label: 'Debug Logs', mark: o.debug, options: [{ label: 'Debug Logs', on: o.debug !== undefined }] },
    { kind: 'input', label: 'Server Address', value: serverAddress(), mono: true, mark: o.server },
    { kind: 'input', label: 'Port', value: '514', mono: true },
  ]
  if (o.netconsole !== undefined) rows.push({ kind: 'toggle', label: 'Netconsole', on: false, mark: o.netconsole, hint: 'optional' })
  rows.push({ kind: 'button', label: 'Apply Changes', mark: o.apply })
  return {
    path: ['Settings', 'CyberSecure', 'Traffic Logging'],
    menu: { items: settingsMenu, active: 'CyberSecure', mark: o.menu },
    tabs: { items: ['Protection', 'Encrypted DNS', 'Ad Blocking', 'Content Filtering', 'Traffic Logging'], active: 'Traffic Logging', mark: o.tab },
    rows,
  }
}

/** Control Plane › Integrations › Activity Logging (CEF events). */
export function integrations(o: { menu?: number; tab?: number; mode?: number; marks?: Record<string, number>; server?: number; apply?: number } = {}): MockSpec {
  const m = o.marks ?? {}
  const c = (label: string) => ({ label, on: true, mark: m[label] })
  return {
    path: ['Settings', 'Control Plane', 'Integrations'],
    menu: { items: settingsMenu, active: 'Control Plane', mark: o.menu },
    tabs: { items: ['Console', 'Admins & Users', 'Integrations', 'Backups'], active: 'Integrations', mark: o.tab },
    rows: [
      { kind: 'segmented', label: 'Activity Logging (Syslog)', options: ['Off', 'SIEM Server'], value: 'SIEM Server', mark: o.mode },
      { kind: 'heading', label: 'UniFi Network' },
      { kind: 'checks', label: 'Categories', options: [c('Clients'), c('Devices'), c('Admin Activity'), c('Security Detections'), c('Triggers'), c('VPN'), c('Critical')] },
      { kind: 'heading', label: 'UniFi OS' },
      { kind: 'checks', label: 'Categories', options: [c('System'), c('Admins'), c('Users'), c('Backups'), c('Updates')] },
      { kind: 'input', label: 'Server Address', value: serverAddress(), mono: true, mark: o.server },
      { kind: 'input', label: 'Port', value: '514', mono: true },
      { kind: 'button', label: 'Apply Changes', mark: o.apply },
    ],
  }
}
