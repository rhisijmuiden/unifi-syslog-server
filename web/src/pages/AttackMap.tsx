// SPDX-License-Identifier: AGPL-3.0-or-later

// Live attack map: blocked inbound traffic drawn as arrows from the source
// country to the firewall. Runs on the live tail (/api/live) and can show
// generated demo traffic. Meant to run fullscreen on a wall display.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { geoArea, geoCentroid, geoGraticule10, geoNaturalEarth1, geoPath } from 'd3-geo'
import { feature } from 'topojson-client'
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson'
import type { Topology } from 'topojson-specification'
import { Maximize2, Minimize2, Pause, Play, Radar, ShieldCheck, Sparkles, Radio } from 'lucide-react'
import { api, type LogRow } from '../api'
import { t } from '../i18n'
import { countryName, flag, numericToAlpha2 } from '../lib/countries'
import { fmtNum } from '../lib/format'
import { cx, Spinner } from '../components/ui'

// ---------------------------------------------------------------- geometry

type Country = Feature<Geometry, { name: string }> & { id?: string }
const W = 960, H = 500

let cache: Promise<Country[]> | null = null
function loadCountries() {
  cache ??= import('world-atlas/countries-110m.json').then((m) => {
    const topo = m.default as unknown as Topology
    const all = (feature(topo, topo.objects.countries) as unknown as FeatureCollection<Geometry, { name: string }>).features as Country[]
    return all.filter((c) => c.id !== '010') // Antarctica only wastes space here
  })
  return cache
}

const alpha2 = (c: Country) => (c.id ? numericToAlpha2[c.id] : c.properties.name === 'Kosovo' ? 'XK' : '') ?? ''

// Centroid of the largest polygon, so France is not placed in the Atlantic
// because of French Guiana and the US not in Canada because of Alaska.
function mainCentroid(c: Country): [number, number] {
  const g = c.geometry
  if (g.type === 'MultiPolygon') {
    let best: Polygon | null = null, area = -1
    for (const coords of (g as MultiPolygon).coordinates) {
      const p: Polygon = { type: 'Polygon', coordinates: coords }
      const a = geoArea(p)
      if (a > area) { area = a; best = p }
    }
    if (best) return geoCentroid(best) as [number, number]
  }
  return geoCentroid(c) as [number, number]
}

// Small fixed offset per IP so arrows from one country do not all overlap.
function jitter(ip: string): [number, number] {
  let h = 2166136261
  for (let i = 0; i < ip.length; i++) h = Math.imul(h ^ ip.charCodeAt(i), 16777619)
  return [((h & 0xff) / 255 - 0.5) * 5, (((h >>> 8) & 0xff) / 255 - 0.5) * 3]
}

// ------------------------------------------------------------------ events

type Kind = 'firewall' | 'ips'
interface Attack {
  id: string
  ts: number
  cc: string
  ip: string
  port: number
  proto: string
  kind: Kind
  rule: string
}

const KIND_COLOR: Record<Kind, string> = { firewall: '#fb7185', ips: '#c084fc' }
const SHIELD = '#22d3ee'

const SERVICES: Record<number, string> = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 110: 'POP3', 123: 'NTP', 135: 'MS-RPC', 161: 'SNMP',
  443: 'HTTPS', 445: 'SMB', 1433: 'MSSQL', 1723: 'PPTP', 1900: 'SSDP', 2375: 'Docker', 3306: 'MySQL', 3389: 'RDP', 5060: 'SIP',
  5432: 'PostgreSQL', 5900: 'VNC', 6379: 'Redis', 8080: 'HTTP-alt', 8443: 'HTTPS-alt', 9200: 'Elastic', 11211: 'Memcached', 27017: 'MongoDB',
}
const service = (port: number) => (port ? SERVICES[port] ?? String(port) : '—')

function fromRow(r: LogRow): Attack | null {
  const cc = (r.fields?.src_country ?? '').toUpperCase()
  if (!cc || !r.src_ip) return null
  return {
    id: `${r.ts}-${r.src_ip}-${r.dst_port}-${Math.random()}`,
    ts: Date.parse(r.ts) || Date.now(),
    cc, ip: r.src_ip, port: r.dst_port, proto: (r.proto || '').toUpperCase(),
    kind: r.category === 'ips' ? 'ips' : 'firewall',
    rule: r.rule,
  }
}

// Demo traffic: weighted countries and the ports scanners usually try.
const DEMO_SOURCES: [string, number, string[]][] = [
  ['CN', 18, ['218.92', '61.177', '222.186']], ['US', 12, ['45.33', '104.248', '167.94']], ['RU', 12, ['185.220', '91.240', '45.141']],
  ['BR', 6, ['177.54', '189.112']], ['IN', 6, ['103.145', '117.211']], ['DE', 5, ['193.142', '5.188']], ['VN', 4, ['14.161', '113.160']],
  ['NL', 4, ['89.248', '80.82']], ['KR', 3, ['121.143']], ['IR', 3, ['5.160']], ['UA', 3, ['91.196']], ['ID', 3, ['36.92']],
  ['GB', 3, ['141.98']], ['FR', 3, ['51.159']], ['SG', 3, ['159.89']], ['TW', 2, ['114.35']], ['TR', 2, ['88.248']], ['MX', 2, ['187.190']],
  ['CA', 2, ['142.93']], ['JP', 2, ['133.242']], ['TH', 2, ['171.97']], ['AR', 1, ['181.47']], ['ZA', 1, ['41.216']], ['NG', 1, ['105.112']],
  ['EG', 1, ['156.204']], ['AU', 1, ['103.75']], ['PK', 1, ['39.45']], ['RO', 2, ['89.38']], ['BG', 1, ['94.156']],
]
const DEMO_PORTS: [number, number][] = [[22, 20], [23, 10], [3389, 10], [445, 7], [80, 6], [443, 5], [8080, 5], [5060, 4], [1433, 4], [3306, 3],
  [6379, 3], [5900, 3], [2375, 2], [25, 2], [9200, 2], [27017, 2], [8443, 2], [161, 1], [123, 1], [11211, 1]]
const DEMO_SIGS = ['ET SCAN Suspicious inbound to MSSQL port 1433', 'ET EXPLOIT Apache log4j RCE Attempt (CVE-2021-44228)', 'ET SCAN NMAP -sS window 1024',
  'ET DROP Spamhaus DROP Listed Traffic Inbound', 'ET SCAN Potential SSH Scan', 'ET POLICY RDP connection request', 'ET CINS Active Threat Intelligence Poor Reputation IP']
const DEMO_RULES = ['WAN_LOCAL-default-D', 'WAN_IN-default-D', 'Block geo region', 'Block threat list']

function pick<T>(list: [T, number][]): T {
  const total = list.reduce((s, [, w]) => s + w, 0)
  let r = Math.random() * total
  for (const [v, w] of list) if ((r -= w) <= 0) return v
  return list[0][0]
}
let demoSeq = 0
function demoAttack(src?: { cc: string; ip: string }): Attack {
  const s = DEMO_SOURCES.map(([cc, w, p]) => [[cc, p], w] as [[string, string[]], number])
  const [cc, prefixes] = src ? [src.cc, []] : pick(s)
  const ip = src?.ip ?? `${prefixes[Math.floor(Math.random() * prefixes.length)]}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 253)}`
  const ips = Math.random() < 0.15
  return {
    id: `demo-${++demoSeq}`, ts: Date.now(), cc, ip,
    port: src ? 1 + Math.floor(Math.random() * 10000) : pick(DEMO_PORTS),
    proto: Math.random() < 0.88 ? 'TCP' : 'UDP',
    kind: ips ? 'ips' : 'firewall',
    rule: ips ? DEMO_SIGS[Math.floor(Math.random() * DEMO_SIGS.length)] : DEMO_RULES[Math.floor(Math.random() * DEMO_RULES.length)],
  }
}

// ---------------------------------------------------------------- page

type Mode = 'live' | 'demo'
const WINDOW_MS = 15 * 60_000
const LIVE_QUERY = 'category:firewall action:block OR category:ips'

export default function AttackMap() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [countries, setCountries] = useState<Country[] | null>(null)
  useEffect(() => { loadCountries().then(setCountries) }, [])

  const [mode, setMode] = useState<Mode>(() => (new URLSearchParams(window.location.search).get('demo') ? 'demo' : 'live'))
  const [paused, setPaused] = useState(false)
  const [full, setFull] = useState(false)
  const [error, setError] = useState<string>()
  const [lastLive, setLastLive] = useState(Date.now())
  const [clock, setClock] = useState(new Date())
  const home = useMemo(() => {
    const p = new URLSearchParams(window.location.search)
    return { cc: (p.get('home') ?? 'NL').toUpperCase(), label: p.get('label') ?? 'Amsterdam' }
  }, [])

  // Events of the last 15 minutes for the side panels; arrows are queued
  // separately so a burst of 500 rows does not launch 500 arrows at once.
  const events = useRef<Attack[]>([])
  const queue = useRef<Attack[]>([])
  const total = useRef(0)
  const [snap, setSnap] = useState(0)

  const push = (list: Attack[]) => {
    if (!list.length) return
    events.current = [...list.reverse(), ...events.current].filter((e) => e.ts > Date.now() - WINDOW_MS).slice(0, 20000)
    total.current += list.length
    queue.current.push(...list.slice(0, 60))
    if (queue.current.length > 120) queue.current = queue.current.slice(-120)
  }

  useEffect(() => { events.current = []; queue.current = []; total.current = 0; setSnap((n) => n + 1) }, [mode])

  // Live tail
  useEffect(() => {
    if (mode !== 'live' || paused) return
    let alive = true
    let cursor = Date.now() - 60_000
    const tick = async () => {
      try {
        const q = new URLSearchParams({ after: String(cursor), query: LIVE_QUERY })
        const res = await api.get<{ rows: LogRow[]; cursor: number }>('/live?' + q)
        if (!alive) return
        cursor = res.cursor
        const list = res.rows.map(fromRow).filter((x): x is Attack => !!x)
        if (list.length) { push(list); setLastLive(Date.now()) }
        setError(undefined)
      } catch (e) { setError((e as Error).message) }
    }
    tick()
    const id = setInterval(tick, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [mode, paused])

  // Demo generator: steady background noise plus the occasional port scan.
  useEffect(() => {
    if (mode !== 'demo' || paused) return
    let alive = true
    let timer = 0
    const loop = () => {
      if (!alive) return
      if (Math.random() < 0.035) {
        const src = demoAttack()
        for (let i = 0; i < 6 + Math.floor(Math.random() * 10); i++) setTimeout(() => alive && push([{ ...demoAttack(src), kind: 'firewall', rule: 'WAN_IN-default-D' }]), i * 90)
      } else push([demoAttack()])
      timer = window.setTimeout(loop, 40 + Math.random() * 160)
    }
    // Seed the panels so they are not empty on the first frame.
    const now = Date.now()
    push(Array.from({ length: 900 }, () => ({ ...demoAttack(), ts: now - Math.random() * WINDOW_MS })).sort((a, b) => a.ts - b.ts))
    queue.current = []
    loop()
    return () => { alive = false; clearTimeout(timer) }
  }, [mode, paused])

  // Panels refresh twice a second, independent of the event rate.
  useEffect(() => {
    const id = setInterval(() => { setSnap((n) => n + 1); setClock(new Date()) }, 500)
    return () => clearInterval(id)
  }, [])

  // Fullscreen
  useEffect(() => {
    const h = () => setFull(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', h)
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select')) return
      if (e.key === 'f') toggleFull()
      if (e.key === ' ') { e.preventDefault(); setPaused((p) => !p) }
    }
    window.addEventListener('keydown', k)
    return () => { document.removeEventListener('fullscreenchange', h); window.removeEventListener('keydown', k) }
  }, [])
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else rootRef.current?.requestFullscreen().catch(() => setFull((f) => !f))
  }

  const stats = useMemo(() => {
    const now = Date.now()
    const list = events.current
    const perMin = list.filter((e) => e.ts > now - 60_000).length
    const byCC = new Map<string, number>(), byPort = new Map<number, number>(), ips = new Set<string>()
    let ipsHits = 0
    for (const e of list) {
      byCC.set(e.cc, (byCC.get(e.cc) ?? 0) + 1)
      if (e.port) byPort.set(e.port, (byPort.get(e.port) ?? 0) + 1)
      ips.add(e.ip)
      if (e.kind === 'ips') ipsHits++
    }
    const top = <K,>(m: Map<K, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n)
    // Per-minute histogram of the window for the sparkline.
    const bins = Array(15).fill(0) as number[]
    for (const e of list) { const i = Math.floor((now - e.ts) / 60_000); if (i >= 0 && i < 15) bins[14 - i]++ }
    return { perMin, total: list.length, sources: ips.size, countries: byCC.size, ipsHits, byCC, topCC: top(byCC, 7), topPorts: top(byPort, 6), bins, feed: list.slice(0, 40) }
  }, [snap]) // eslint-disable-line react-hooks/exhaustive-deps

  const quiet = mode === 'live' && !paused && Date.now() - lastLive > 20_000 && !events.current.length

  return (
    <div ref={rootRef} className={cx('attack-map relative flex flex-col overflow-hidden text-slate-200', full ? 'fixed inset-0 z-50 h-screen w-screen' : 'h-[calc(100vh-7.5rem)] min-h-[560px] rounded-3xl ring-1 ring-[var(--border)]')}>
      {/* Header */}
      <div className="relative z-10 flex flex-wrap items-center gap-3 border-b border-white/5 px-5 py-3">
        <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500/25 to-cyan-500/25 text-cyan-300 ring-1 ring-cyan-400/30"><Radar className="size-5" /></div>
        <div className="mr-auto">
          <div className="flex items-center gap-2 text-base font-semibold text-white">
            {t('Live attack map')}
            <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider', paused ? 'bg-amber-500/15 text-amber-300' : 'bg-rose-500/15 text-rose-300')}>
              <span className={cx('size-1.5 rounded-full', paused ? 'bg-amber-400' : 'bg-rose-400 pulse-dot')} />
              {paused ? t('Paused') : mode === 'demo' ? t('Demo') : t('Live')}
            </span>
          </div>
          <div className="text-xs text-slate-400">{t('Blocked inbound traffic, last 15 minutes')}</div>
        </div>
        {full && <div className="hidden text-right font-mono text-2xl tabular-nums text-white/90 md:block">{clock.toLocaleTimeString()}</div>}
        <div className="flex items-center rounded-xl bg-white/5 p-1 ring-1 ring-white/10">
          {(['live', 'demo'] as Mode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={cx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition', mode === m ? 'bg-gradient-to-r from-indigo-500 to-cyan-500 text-white shadow' : 'text-slate-300 hover:text-white')}>
              {m === 'live' ? <Radio className="size-3.5" /> : <Sparkles className="size-3.5" />}{m === 'live' ? t('Live data') : t('Demo data')}
            </button>
          ))}
        </div>
        <button onClick={() => setPaused(!paused)} title={t('Pause (space)')} className="grid size-9 place-items-center rounded-xl bg-white/5 text-slate-200 ring-1 ring-white/10 hover:bg-white/10">
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
        </button>
        <button onClick={toggleFull} title={t('Fullscreen (F)')} className="flex h-9 items-center gap-2 rounded-xl bg-white/5 px-3 text-xs font-medium text-slate-200 ring-1 ring-white/10 hover:bg-white/10">
          {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}{full ? t('Exit fullscreen') : t('Fullscreen')}
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1">
        {/* Map */}
        <div className="relative min-w-0 flex-1">
          {!countries ? <div className="grid h-full place-items-center"><Spinner className="size-8" /></div>
            : <MapStage countries={countries} home={home} queue={queue} counts={stats.byCC} paused={paused} />}

          {/* Counters */}
          <div className={cx('pointer-events-none absolute left-5 top-4 grid gap-2', full ? 'grid-cols-4' : 'grid-cols-2 xl:grid-cols-4')}>
            <Counter label={t('Blocked / min')} value={fmtNum(stats.perMin)} accent="text-rose-300" big={full} />
            <Counter label={t('Blocked (15 min)')} value={fmtNum(stats.total)} big={full} />
            <Counter label={t('Unique sources')} value={fmtNum(stats.sources)} big={full} />
            <Counter label={t('Countries')} value={fmtNum(stats.countries)} big={full} />
          </div>

          {/* Legend */}
          <div className="pointer-events-none absolute bottom-4 left-5 flex flex-wrap items-center gap-4 rounded-xl bg-slate-950/60 px-3 py-2 text-[11px] text-slate-300 ring-1 ring-white/10 backdrop-blur">
            <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 rounded" style={{ background: `linear-gradient(90deg, transparent, ${KIND_COLOR.firewall})` }} />{t('Firewall block')}</span>
            <span className="flex items-center gap-1.5"><span className="h-0.5 w-5 rounded" style={{ background: `linear-gradient(90deg, transparent, ${KIND_COLOR.ips})` }} />{t('Threat stopped by IPS')}</span>
            <span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-cyan-300" />{t('Your firewall')}</span>
          </div>

          {quiet && (
            <div className="absolute inset-x-0 bottom-16 mx-auto w-fit max-w-md rounded-2xl bg-slate-900/80 px-4 py-3 text-center text-sm ring-1 ring-white/10 backdrop-blur">
              <div className="font-medium text-white">{t('No blocked traffic received yet')}</div>
              <div className="mt-1 text-xs text-slate-400">{t('Enable syslog for blocked traffic on the built-in firewall rules, or have a look with demo data.')}</div>
              <button onClick={() => setMode('demo')} className="mt-2 rounded-lg bg-gradient-to-r from-indigo-500 to-cyan-500 px-3 py-1.5 text-xs font-medium text-white">{t('Show demo data')}</button>
            </div>
          )}
          {error && <div className="absolute right-4 top-4 rounded-lg bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200 ring-1 ring-rose-500/30">{error}</div>}
        </div>

        {/* Side panel */}
        <aside className={cx('flex shrink-0 flex-col gap-4 overflow-hidden border-l border-white/5 bg-slate-950/30 p-4 backdrop-blur', full ? 'w-[380px]' : 'w-[320px] max-lg:hidden')}>
          <Section title={t('Attacks per minute')}>
            <Spark bins={stats.bins} />
          </Section>
          <Section title={t('Top source countries')}>
            <div className="space-y-1.5">
              {stats.topCC.map(([cc, n]) => (
                <Bar key={cc} label={<><span className="mr-1.5">{flag(cc)}</span>{countryName(cc)}</>} n={n} max={stats.topCC[0]?.[1] ?? 1} color="from-rose-500 to-orange-400" />
              ))}
            </div>
          </Section>
          <Section title={t('Most targeted services')}>
            <div className="flex flex-wrap gap-1.5">
              {stats.topPorts.map(([p, n]) => (
                <span key={p} className="rounded-lg bg-white/5 px-2 py-1 text-[11px] ring-1 ring-white/10"><span className="font-semibold text-white">{service(p)}</span> <span className="text-slate-400">{p} · {fmtNum(n)}</span></span>
              ))}
            </div>
          </Section>
          <Section title={t('Live feed')} grow>
            <div className="scroll-thin -mr-2 h-full space-y-1 overflow-y-auto pr-2">
              {stats.feed.map((e) => (
                <Link key={e.id} to={`/logs?q=${encodeURIComponent('src_ip:' + e.ip)}`} className="feed-row flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px] hover:bg-white/5">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: KIND_COLOR[e.kind], boxShadow: `0 0 8px ${KIND_COLOR[e.kind]}` }} />
                  <span className="shrink-0 whitespace-nowrap font-mono text-slate-500">{new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
                  <span className="shrink-0">{flag(e.cc)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-slate-200" title={e.rule}>{e.ip}</span>
                  <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-slate-300">{service(e.port)}</span>
                </Link>
              ))}
            </div>
          </Section>
        </aside>
      </div>
    </div>
  )
}

function Counter({ label, value, accent, big }: { label: string; value: string; accent?: string; big?: boolean }) {
  return (
    <div className="rounded-2xl bg-slate-950/55 px-4 py-2.5 ring-1 ring-white/10 backdrop-blur">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</div>
      <div className={cx('font-semibold tabular-nums text-white', big ? 'text-3xl' : 'text-xl', accent)}>{value}</div>
    </div>
  )
}

function Section({ title, children, grow }: { title: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <div className={cx(grow && 'flex min-h-0 flex-1 flex-col')}>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-slate-400">{title}</div>
      <div className={cx(grow && 'min-h-0 flex-1')}>{children}</div>
    </div>
  )
}

function Bar({ label, n, max, color }: { label: React.ReactNode; n: number; max: number; color: string }) {
  return (
    <div className="text-xs">
      <div className="mb-0.5 flex justify-between"><span className="truncate">{label}</span><span className="tabular-nums text-slate-400">{fmtNum(n)}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/5"><div className={cx('h-full rounded-full bg-gradient-to-r transition-all duration-500', color)} style={{ width: `${(100 * n) / max}%` }} /></div>
    </div>
  )
}

function Spark({ bins }: { bins: number[] }) {
  const max = Math.max(1, ...bins)
  return (
    <div className="flex h-14 items-end gap-1">
      {bins.map((b, i) => (
        <div key={i} className="flex-1 rounded-t bg-gradient-to-t from-indigo-500/60 to-cyan-400/80 transition-all duration-500" style={{ height: `${Math.max(4, (100 * b) / max)}%`, opacity: i === bins.length - 1 ? 1 : 0.75 }} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- map + animation

interface Flight { a: Attack; p0: [number, number]; c: [number, number]; p1: [number, number]; start: number; dur: number }
interface Impact { x: number; y: number; start: number; color: string }
interface Ping { x: number; y: number; start: number; color: string }

function MapStage({ countries, home, queue, counts, paused }: {
  countries: Country[]; home: { cc: string; label: string }; queue: React.MutableRefObject<Attack[]>; counts: Map<string, number>; paused: boolean
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [box, setBox] = useState({ w: W, h: H, x: 0, y: 0 })
  const [hover, setHover] = useState<{ cc: string; x: number; y: number } | null>(null)

  const projection = useMemo(() => geoNaturalEarth1().fitExtent([[10, 30], [W - 10, H - 10]], { type: 'FeatureCollection', features: countries }), [countries])
  const path = useMemo(() => geoPath(projection), [projection])
  const centroids = useMemo(() => new Map(countries.map((c) => [alpha2(c), mainCentroid(c)])), [countries])
  const homeXY = useMemo(() => projection(centroids.get(home.cc) ?? [4.9, 52.37]) as [number, number], [projection, centroids, home.cc])
  const max = Math.max(1, ...counts.values())

  // Fit the W×H stage into the container (letterboxed) and size the canvas.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect()
      const s = Math.min(width / W, height / H)
      setBox({ w: W * s, h: H * s, x: (width - W * s) / 2, y: (height - H * s) / 2 })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const dpr = window.devicePixelRatio || 1
    cv.width = box.w * dpr; cv.height = box.h * dpr
    const ctx = cv.getContext('2d')!
    const s = (box.w / W) * dpr
    const flights: Flight[] = []
    const impacts: Impact[] = []
    const pings: Ping[] = []
    let lastLaunch = 0
    let heat = 0
    let raf = 0
    const R = 16 // shield radius in stage units

    const launch = (a: Attack, now: number) => {
      const ll = centroids.get(a.cc)
      if (!ll) return
      const [jx, jy] = jitter(a.ip)
      const src = projection([ll[0] + jx, ll[1] + jy])
      if (!src) return
      const [hx, hy] = homeXY
      const dx = hx - src[0], dy = hy - src[1]
      const d = Math.hypot(dx, dy)
      if (d < R * 1.5) { impacts.push({ x: hx, y: hy, start: now, color: KIND_COLOR[a.kind] }); heat = Math.min(1, heat + 0.25); return }
      // Control point lifted perpendicular to the line, always "upwards".
      let nx = -dy / d, ny = dx / d
      if (ny > 0) { nx = -nx; ny = -ny }
      const lift = Math.min(160, d * 0.32)
      const c: [number, number] = [(src[0] + hx) / 2 + nx * lift, (src[1] + hy) / 2 + ny * lift]
      // Stop on the shield edge instead of the centre.
      const ux = hx - c[0], uy = hy - c[1], ul = Math.hypot(ux, uy)
      const p1: [number, number] = [hx - (ux / ul) * R, hy - (uy / ul) * R]
      flights.push({ a, p0: src, c, p1, start: now, dur: 1500 + d * 3 })
      pings.push({ x: src[0], y: src[1], start: now, color: KIND_COLOR[a.kind] })
    }

    const bez = (f: Flight, t: number): [number, number] => {
      const u = 1 - t
      return [u * u * f.p0[0] + 2 * u * t * f.c[0] + t * t * f.p1[0], u * u * f.p0[1] + 2 * u * t * f.c[1] + t * t * f.p1[1]]
    }
    const rgba = (hex: string, a: number) => {
      const n = parseInt(hex.slice(1), 16)
      return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`
    }
    const ease = (t: number) => 1 - Math.pow(1 - t, 2.2)

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (pausedRef.current) return
      // Release queued attacks at a steady rate, faster when the queue grows.
      const gap = Math.max(20, 140 - queue.current.length * 4)
      if (queue.current.length && now - lastLaunch > gap && flights.length < 90) {
        launch(queue.current.shift()!, now); lastLaunch = now
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, cv.width, cv.height)
      ctx.setTransform(s, 0, 0, s, 0, 0)
      ctx.globalCompositeOperation = 'lighter'

      // Source pings
      for (let i = pings.length - 1; i >= 0; i--) {
        const p = pings[i], k = (now - p.start) / 900
        if (k >= 1) { pings.splice(i, 1); continue }
        ctx.beginPath(); ctx.arc(p.x, p.y, 2 + k * 9, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(p.color, 0.7 * (1 - k)); ctx.lineWidth = 1.2; ctx.stroke()
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2); ctx.fillStyle = rgba(p.color, 1 - k); ctx.fill()
      }

      // Flights
      for (let i = flights.length - 1; i >= 0; i--) {
        const f = flights[i]
        const raw = (now - f.start) / f.dur
        const col = KIND_COLOR[f.a.kind]
        if (raw >= 1) {
          flights.splice(i, 1)
          impacts.push({ x: f.p1[0], y: f.p1[1], start: now, color: col })
          heat = Math.min(1, heat + 0.18)
          continue
        }
        const t = ease(raw)
        // Faint full route
        ctx.beginPath(); ctx.moveTo(f.p0[0], f.p0[1]); ctx.quadraticCurveTo(f.c[0], f.c[1], f.p1[0], f.p1[1])
        ctx.strokeStyle = rgba(col, 0.07); ctx.lineWidth = 0.8; ctx.stroke()
        // Tail: segments with rising opacity and width
        const tail = 0.28, steps = 14, t0 = Math.max(0, t - tail)
        let prev = bez(f, t0)
        for (let j = 1; j <= steps; j++) {
          const tj = t0 + ((t - t0) * j) / steps
          const p = bez(f, tj)
          const k = j / steps
          ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1])
          ctx.strokeStyle = rgba(col, 0.85 * k * k); ctx.lineWidth = 0.4 + 1.8 * k; ctx.lineCap = 'round'; ctx.stroke()
          prev = p
        }
        // Arrow head along the tangent
        const [x, y] = bez(f, t)
        const [x2, y2] = bez(f, Math.max(0, t - 0.01))
        const ang = Math.atan2(y - y2, x - x2)
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang)
        ctx.shadowColor = col; ctx.shadowBlur = 10 * s
        ctx.beginPath(); ctx.moveTo(4.5, 0); ctx.lineTo(-3, -2.8); ctx.lineTo(-1.6, 0); ctx.lineTo(-3, 2.8); ctx.closePath()
        ctx.fillStyle = rgba('#ffffff', 0.95); ctx.fill()
        ctx.restore()
      }

      // Impacts on the shield: a ring and a few sparks bouncing off.
      for (let i = impacts.length - 1; i >= 0; i--) {
        const m = impacts[i], k = (now - m.start) / 700
        if (k >= 1) { impacts.splice(i, 1); continue }
        ctx.beginPath(); ctx.arc(m.x, m.y, 2 + k * 10, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(m.color, 0.9 * (1 - k)); ctx.lineWidth = 1.5 * (1 - k) + 0.3; ctx.stroke()
        for (let j = 0; j < 4; j++) {
          const a = (j / 4) * Math.PI * 2 + m.start
          ctx.beginPath(); ctx.arc(m.x + Math.cos(a) * k * 12, m.y + Math.sin(a) * k * 12, 0.9 * (1 - k), 0, Math.PI * 2)
          ctx.fillStyle = rgba(m.color, 1 - k); ctx.fill()
        }
      }

      // Shield around the firewall: steady rings, brighter while under fire.
      heat *= 0.965
      const [hx, hy] = homeXY
      const pulse = (now % 2400) / 2400
      ctx.beginPath(); ctx.arc(hx, hy, R + pulse * 22, 0, Math.PI * 2)
      ctx.strokeStyle = rgba(SHIELD, 0.35 * (1 - pulse)); ctx.lineWidth = 1; ctx.stroke()
      const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, R + 6)
      g.addColorStop(0, rgba(SHIELD, 0.05 + heat * 0.15)); g.addColorStop(0.75, rgba(SHIELD, 0.12 + heat * 0.35)); g.addColorStop(1, rgba(SHIELD, 0))
      ctx.beginPath(); ctx.arc(hx, hy, R + 6, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill()
      ctx.beginPath(); ctx.arc(hx, hy, R, 0, Math.PI * 2)
      ctx.strokeStyle = rgba(SHIELD, 0.55 + heat * 0.45); ctx.lineWidth = 1.2 + heat * 1.5
      ctx.shadowColor = SHIELD; ctx.shadowBlur = (6 + heat * 18) * s; ctx.stroke(); ctx.shadowBlur = 0
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [box, projection, centroids, homeXY, queue])

  const heatOpacity = (n: number) => (n ? 0.03 + 0.32 * Math.pow(Math.log(n + 1) / Math.log(max + 1), 2) : 0)
  const graticule = useMemo(() => path(geoGraticule10()) ?? '', [path])

  return (
    <div ref={wrap} className="absolute inset-0" onMouseLeave={() => setHover(null)}>
      <div className="absolute" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full">
          <defs>
            <radialGradient id="am-glow" cx="50%" cy="45%" r="65%">
              <stop offset="0%" stopColor="#1e293b" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#020617" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect width={W} height={H} fill="url(#am-glow)" />
          <path d={graticule} fill="none" stroke="#38bdf8" strokeOpacity={0.05} strokeWidth={0.5} />
          {countries.map((c, i) => {
            const cc = alpha2(c)
            const n = counts.get(cc) ?? 0
            const d = path(c) ?? ''
            return (
              <g key={i} onMouseMove={(e) => {
                const r = wrap.current!.getBoundingClientRect()
                setHover({ cc, x: e.clientX - r.left, y: e.clientY - r.top })
              }}>
                <path d={d} fill="#1b2438" stroke="#2c3a55" strokeWidth={0.45} />
                {n > 0 && <path d={d} fill="#f43f5e" fillOpacity={heatOpacity(n)} stroke="#fb7185" strokeOpacity={0.25} strokeWidth={0.45} className="transition-[fill-opacity] duration-700" />}
              </g>
            )
          })}
        </svg>
        <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" />
        {/* Firewall marker */}
        <div className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${(homeXY[0] / W) * 100}%`, top: `${(homeXY[1] / H) * 100}%` }}>
          <div className="grid size-6 place-items-center rounded-full bg-slate-950/90 text-cyan-300 ring-1 ring-cyan-400/60"><ShieldCheck className="size-3.5" /></div>
          <div className="absolute left-1/2 top-[calc(100%+20px)] -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-950/80 px-2 py-0.5 text-[10px] font-medium text-cyan-200 ring-1 ring-cyan-400/30">
            {flag(home.cc)} {home.label}
          </div>
        </div>
      </div>
      {hover?.cc && (
        <div className="pointer-events-none absolute z-10 rounded-xl bg-slate-900/95 px-3 py-2 text-xs shadow-xl ring-1 ring-white/10" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="font-medium text-white">{flag(hover.cc)} {countryName(hover.cc)}</div>
          <div className="tabular-nums text-slate-400">{t('{n} blocked', { n: fmtNum(counts.get(hover.cc) ?? 0) })}</div>
        </div>
      )}
    </div>
  )
}
