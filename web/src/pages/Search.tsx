import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Search as SearchIcon, X, ScrollText, Router as RouterIcon, Smartphone, MapPin, Tags, Bookmark, BellRing, Megaphone, RadioTower,
  Send, Server, Users, LayoutGrid, ChevronRight, ArrowRight, CornerDownLeft,
} from 'lucide-react'
import { api, can, type LogRow } from '../api'
import { nav, useAuth } from '../App'
import { useUrlState } from '../components/Filters'
import { Badge, Button, Card, Empty, PageHeader, Select, Spinner, cx } from '../components/ui'
import { catColor, catLabel, fmtNum, fmtTime, presetRange, rangePresets, severities, severityClass } from '../lib/format'
import { t } from '../i18n'

interface Item { id: string; title: string; subtitle?: string; badge?: string; link: string }
interface Group { type: string; total: number; items: Item[] }
interface LogResult { query: string; count: number; rows: LogRow[]; error?: string }

const types: Record<string, { label: string; icon: ReactNode }> = {
  device: { label: 'Devices', icon: <RouterIcon /> },
  client: { label: 'Clients', icon: <Smartphone /> },
  site: { label: 'Sites', icon: <MapPin /> },
  category: { label: 'Categories', icon: <Tags /> },
  saved_search: { label: 'Saved searches', icon: <Bookmark /> },
  alert: { label: 'Alerts', icon: <BellRing /> },
  channel: { label: 'Notification channels', icon: <Megaphone /> },
  probe: { label: 'Remote probes', icon: <RadioTower /> },
  forward: { label: 'Forwarding', icon: <Send /> },
  controller: { label: 'UniFi controllers', icon: <Server /> },
  user: { label: 'Users', icon: <Users /> },
}

const badges: Record<string, { label: string; className: string }> = {
  disabled: { label: 'disabled', className: 'text-muted' },
  offline: { label: 'Offline', className: 'bg-red-500/10 text-red-500 ring-red-500/30' },
  'not enrolled': { label: 'not enrolled', className: 'bg-amber-500/10 text-amber-500 ring-amber-500/30' },
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Highlights the search words in a text. */
function Mark({ text, words }: { text: string; words: string[] }) {
  if (!words.length || !text) return <>{text}</>
  const re = new RegExp(`(${words.map(escapeRe).join('|')})`, 'gi')
  return <>{text.split(re).map((p, i) => i % 2 ? <mark key={i} className="rounded bg-indigo-500/20 px-0.5 text-inherit">{p}</mark> : <Fragment key={i}>{p}</Fragment>)}</>
}

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v)
  useEffect(() => { const h = setTimeout(() => setD(v), ms); return () => clearTimeout(h) }, [v, ms])
  return d
}

export default function SearchPage() {
  const { user } = useAuth()
  const go = useNavigate()
  const [st, set] = useUrlState({ q: '', type: '', preset: '24h' })
  const input = useRef<HTMLInputElement>(null)
  const q = useDebounced(st.q.trim(), 250)
  const words = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q])

  const [groups, setGroups] = useState<Group[]>()
  const [logs, setLogs] = useState<LogResult>()
  const [busy, setBusy] = useState({ meta: false, logs: false })
  const [sel, setSel] = useState(0)

  useEffect(() => {
    const h = () => { input.current?.focus(); input.current?.select() }
    window.addEventListener('uss:search-focus', h)
    return () => window.removeEventListener('uss:search-focus', h)
  }, [])

  useEffect(() => {
    setSel(0)
    if (!q) { setGroups(undefined); return }
    let alive = true
    setBusy((b) => ({ ...b, meta: true }))
    api.get<{ groups: Group[] }>('/global-search?' + new URLSearchParams({ q }))
      .then((r) => alive && setGroups(r.groups)).catch(() => alive && setGroups([]))
      .finally(() => alive && setBusy((b) => ({ ...b, meta: false })))
    return () => { alive = false }
  }, [q])

  useEffect(() => {
    if (!q) { setLogs(undefined); return }
    let alive = true
    const r = presetRange(st.preset)
    setBusy((b) => ({ ...b, logs: true }))
    api.get<LogResult>('/global-search/logs?' + new URLSearchParams({ q, from: r.from.toISOString(), to: r.to.toISOString() }))
      .then((x) => alive && setLogs(x)).catch((e) => alive && setLogs({ query: q, count: 0, rows: [], error: (e as Error).message }))
      .finally(() => alive && setBusy((b) => ({ ...b, logs: false })))
    return () => { alive = false }
  }, [q, st.preset])

  // Menu pages and settings, matched in English and in the user's language.
  const pages = useMemo(() => {
    if (!words.length) return []
    return nav.flatMap((g) => g.items.filter((i) => !i.admin || can.admin(user)).map((i) => ({ ...i, section: g.section })))
      .filter((i) => {
        const hay = `${i.label} ${t(i.label)} ${i.keywords ?? ''} ${t(i.section)}`.toLowerCase()
        return words.every((w) => hay.includes(w))
      })
  }, [words, user])

  const logsLink = logs ? '/logs?' + new URLSearchParams({ q: logs.query, preset: st.preset }) : '/logs'
  const show = (type: string) => !st.type || st.type === type
  const visibleGroups = (groups ?? []).filter((g) => show(g.type))

  // Every result in display order, for the arrow keys.
  const links = useMemo(() => [
    ...(show('page') ? pages.map((p) => p.to) : []),
    ...(show('logs') && logs?.count ? [logsLink] : []),
    ...visibleGroups.flatMap((g) => g.items.map((i) => i.link)),
  ], [pages, logs, logsLink, visibleGroups, st.type]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [sel])
  let idx = -1
  const nextIdx = () => ++idx

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, links.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter' && links[sel]) go(links[sel])
    else if (e.key === 'Escape') set({ q: '' })
  }

  const counts: [string, string, number][] = [
    ['page', 'Pages & settings', pages.length],
    ['logs', 'Log messages', logs?.count ?? 0],
    ...(groups ?? []).map((g) => [g.type, types[g.type]?.label ?? g.type, g.total] as [string, string, number]),
  ]
  const total = pages.length + (logs?.count ? 1 : 0) + (groups ?? []).reduce((n, g) => n + g.total, 0)
  const searching = busy.meta || busy.logs

  const row = (key: string, link: string, icon: ReactNode, title: ReactNode, subtitle?: ReactNode, badge?: ReactNode) => {
    const i = nextIdx()
    return (
      <Link key={key} to={link} data-selected={i === sel} onMouseEnter={() => setSel(i)}
        className={cx('group flex items-center gap-3 rounded-xl px-3 py-2.5 transition [&>svg]:size-4', i === sel ? 'bg-indigo-500/10 ring-1 ring-indigo-500/30' : 'hover:bg-[var(--panel-2)]')}>
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--panel-2)] text-indigo-400 [&_svg]:size-4">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          {subtitle && <span className="block truncate text-xs text-muted">{subtitle}</span>}
        </span>
        {badge}
        {i === sel ? <CornerDownLeft className="shrink-0 text-indigo-400" /> : <ChevronRight className="shrink-0 text-muted opacity-0 group-hover:opacity-100" />}
      </Link>
    )
  }

  // Log messages come first when there are any, at the end otherwise.
  const logsFirst = !logs || logs.count > 0
  const logsCard = () => show('logs') && (

            <Card className="xl:col-span-2" pad={false}
              title={<span className="flex items-center gap-2"><ScrollText className="size-4 text-indigo-400" />{t('Log messages')}{logs && !busy.logs && <Badge>{fmtNum(logs.count)}</Badge>}</span>}
              subtitle={logs?.query && <span className="font-mono">{logs.query}</span>}
              actions={<>
                <Select value={st.preset} onChange={(preset) => set({ preset })} className="!py-1.5 text-xs" options={rangePresets.map((p) => ({ value: p.key, label: t(p.label) }))} />
                {logs && logs.count > 0 && <Link to={logsLink}><Button variant="ghost" icon={<ArrowRight className="size-4" />}>{t('Open in Logs')}</Button></Link>}
              </>}>
              {busy.logs && !logs ? <div className="grid place-items-center py-10"><Spinner /></div>
                : logs?.error ? <p className="px-5 py-4 text-sm text-red-500">{logs.error}</p>
                : !logs?.rows.length ? <p className="px-5 py-4 text-sm text-muted">{t('No log messages match in this time range.')}</p>
                : (
                  <div className={cx('divide-y divide-[var(--border)] transition', busy.logs && 'opacity-60')}>
                    {(() => { const i = nextIdx(); return (
                      <Link to={logsLink} data-selected={i === sel} onMouseEnter={() => setSel(i)} className={cx('block', i === sel && 'bg-indigo-500/5')}>
                        {logs.rows.map((r, n) => (
                          <div key={r.received + n} className="flex min-w-0 items-center gap-3 px-5 py-2 text-sm hover:bg-[var(--panel-2)]">
                            <span className="hidden whitespace-nowrap font-mono text-xs text-muted sm:block">{fmtTime(r.ts)}</span>
                            <Badge className={severityClass(r.severity)}>{severities[r.severity]}</Badge>
                            <span className="hidden max-w-[160px] truncate text-xs font-medium md:block">{r.fields?.device_name || r.hostname}</span>
                            <Badge color={catColor(r.category)}>{catLabel(r.category)}</Badge>
                            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={r.message}><Mark text={r.message} words={words} /></span>
                          </div>
                        ))}
                      </Link>
                    ) })()}
                    {logs.count > logs.rows.length && (
                      <Link to={logsLink} className="block px-5 py-2.5 text-center text-xs text-indigo-400 hover:underline">{t('Show all {n} messages', { n: fmtNum(logs.count) })}</Link>
                    )}
                  </div>
                )}
            </Card>
  )

  return (
    <>
      <PageHeader title={t('Search')} subtitle={t('Find log messages, devices, clients, settings and everything else in one place')} icon={<SearchIcon className="size-5" />} />

      <div className="panel mb-4 flex items-center gap-3 rounded-2xl px-4 py-3 shadow-sm focus-within:ring-2 focus-within:ring-indigo-500/40">
        {searching ? <Spinner className="size-5 shrink-0" /> : <SearchIcon className="size-5 shrink-0 text-muted" />}
        <input ref={input} autoFocus value={st.q} onChange={(e) => set({ q: e.target.value })} onKeyDown={onKey}
          placeholder={t('Search for a device, MAC or IP address, client, alert, setting or log text…')}
          aria-label={t('Search')} className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted" />
        {st.q && <button onClick={() => { set({ q: '' }); input.current?.focus() }} aria-label={t('Clear')} title={t('Clear')} className="cursor-pointer rounded-lg p-1 text-muted hover:bg-[var(--panel-2)]"><X className="size-4" /></button>}
      </div>

      {q && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {[['', 'All', total] as [string, string, number], ...counts].map(([k, label, n]) => (
            <button key={k} onClick={() => { set({ type: k }); setSel(0) }}
              className={cx('inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 transition',
                st.type === k ? 'bg-gradient-to-r from-indigo-500 to-cyan-500 text-white ring-transparent' : 'text-muted ring-[var(--border)] hover:text-[var(--text)]',
                k && !n && st.type !== k && 'opacity-50')}>
              {t(label)}<span className={cx('rounded-full px-1.5 text-[10px]', st.type === k ? 'bg-white/20' : 'bg-[var(--panel-2)]')}>{fmtNum(n)}</span>
            </button>
          ))}
        </div>
      )}

      {!q ? (
        <Card>
          <Empty icon={<SearchIcon className="size-8" />} title={t('Search everything')}
            text={t('Type a name, MAC address, IP address or any text. Log messages are searched with the same filter language as the Logs page, for example category:firewall action:block.')} />
          <div className="mx-auto flex max-w-xl flex-wrap justify-center gap-2 pb-6">
            {['category:firewall action:block', 'category:ips', 'U6', 'backup', 'smtp'].map((x) => (
              <button key={x} onClick={() => set({ q: x })} className="cursor-pointer rounded-lg bg-[var(--panel-2)] px-2.5 py-1 font-mono text-xs ring-1 ring-[var(--border)] hover:ring-indigo-400/60">{x}</button>
            ))}
          </div>
          <p className="pb-2 text-center text-xs text-muted">{t('Tip: press Ctrl+K or / anywhere to open the search, use the arrow keys and Enter to open a result.')}</p>
        </Card>
      ) : !searching && total === 0 && !logs?.error ? (
        <Card><Empty icon={<SearchIcon className="size-8" />} title={t('Nothing found for "{q}"', { q })} text={t('Try fewer or other words, or a longer time range for log messages.')} /></Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {show('page') && pages.length > 0 && (
            <Card title={t('Pages & settings')} pad={false} className="xl:col-span-2">
              <div className="grid gap-1 p-2 sm:grid-cols-2 lg:grid-cols-3">
                {pages.map((p) => row(p.to, p.to, p.icon, <Mark text={t(p.label)} words={words} />, t(p.section)))}
              </div>
            </Card>
          )}

          {logsFirst && logsCard()}

          {visibleGroups.map((g) => {
            const ty = types[g.type] ?? { label: g.type, icon: <LayoutGrid /> }
            return (
              <Card key={g.type} pad={false}
                title={<span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:text-indigo-400">{ty.icon}{t(ty.label)}<Badge>{fmtNum(g.total)}</Badge></span>}
                actions={g.total > g.items.length && <span className="text-xs text-muted">{t('Showing {n} of {total}', { n: g.items.length, total: g.total })}</span>}>
                <div className="space-y-0.5 p-2">
                  {g.items.map((it) => {
                    const b = it.badge ? badges[it.badge] : undefined
                    return row(g.type + it.id, it.link, ty.icon, <Mark text={it.title} words={words} />,
                      it.subtitle && <Mark text={it.subtitle} words={words} />,
                      it.badge && <Badge className={b?.className}>{t(b?.label ?? it.badge)}</Badge>)
                  })}
                </div>
              </Card>
            )
          })}

          {!logsFirst && logsCard()}
        </div>
      )}
    </>
  )
}
