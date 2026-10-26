import type { ReactNode } from 'react'
import { ChevronRight, LayoutDashboard, Network, Settings, Shield, Smartphone, Wifi, Router as RouterIcon, Camera, DoorOpen } from 'lucide-react'
import { cx } from '../components/ui'
import { t } from '../i18n'

// Annotated illustrations of the UniFi screens a guide refers to. They are
// drawn, not screenshots: labels are the English names UniFi itself uses, so
// they match the console whatever language this interface is in. Rows with a
// mark get a numbered callout that matches a step in the guide.

export type MockRow =
  | { kind: 'select'; label: string; value: string; mark?: number }
  | { kind: 'segmented'; label: string; options: string[]; value: string; mark?: number }
  | { kind: 'checks'; label: string; options: { label: string; on: boolean; mark?: number }[]; mark?: number }
  | { kind: 'toggle'; label: string; on: boolean; hint?: string; mark?: number }
  | { kind: 'input'; label: string; value: string; mono?: boolean; mark?: number }
  | { kind: 'table'; label: string; columns: string[]; rows: { cells: string[]; mark?: number }[] }
  | { kind: 'button'; label: string; mark?: number }
  | { kind: 'heading'; label: string }

export interface MockSpec {
  app?: 'network' | 'os' | 'protect' | 'access'
  /** Breadcrumb, e.g. ['Settings', 'CyberSecure', 'Traffic Logging']. */
  path: string[]
  /** Settings sub menu with the active entry; omit to hide it. */
  menu?: { items: string[]; active: string; mark?: number }
  tabs?: { items: string[]; active: string; mark?: number }
  /** Title of a side panel (policy editor) instead of a page. */
  panel?: string
  rows: MockRow[]
}

const appLabel = { network: 'Network', os: 'UniFi OS', protect: 'Protect', access: 'Access' }
const blue = '#006fff'

function Mark({ n, className }: { n?: number; className?: string }) {
  if (!n) return null
  return (
    <span className={cx('pointer-events-none absolute z-10 grid size-6 place-items-center rounded-full bg-amber-400 text-[11px] font-bold text-slate-900 shadow-lg shadow-amber-500/30 ring-2 ring-white', className)}>
      {n}
    </span>
  )
}

function Hl({ mark, children, className }: { mark?: number; children: ReactNode; className?: string }) {
  return (
    <div className={cx('relative rounded-lg', !!mark && 'ring-2 ring-amber-400 ring-offset-2 ring-offset-white', className)}>
      <Mark n={mark} className="-right-3 -top-3" />
      {children}
    </div>
  )
}

function Check({ on }: { on: boolean }) {
  return (
    <span className="grid size-4 shrink-0 place-items-center rounded border" style={on ? { background: blue, borderColor: blue } : { borderColor: '#c4cad4', background: '#fff' }}>
      {on && <svg viewBox="0 0 12 12" className="size-3 text-white"><path d="M2.5 6.5l2.2 2.2L9.5 3.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </span>
  )
}

function Row({ r }: { r: MockRow }) {
  const label = <div className="w-44 shrink-0 pt-1 text-[12px] text-slate-500">{r.label}</div>
  switch (r.kind) {
    case 'heading':
      return <div className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{r.label}</div>
    case 'select':
      return (
        <div className="flex flex-wrap gap-2">{label}
          <Hl mark={r.mark}><div className="flex w-52 items-center justify-between rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[12px] text-slate-800">{r.value}<ChevronRight className="size-3 rotate-90 text-slate-400" /></div></Hl>
        </div>
      )
    case 'segmented':
      return (
        <div className="flex flex-wrap gap-2">{label}
          <Hl mark={r.mark}>
            <div className="flex rounded-md bg-slate-100 p-0.5 text-[12px]">
              {r.options.map((o) => (
                <span key={o} className={cx('rounded px-2.5 py-0.5', o === r.value ? 'bg-white font-medium shadow-sm' : 'text-slate-500')} style={o === r.value ? { color: blue } : undefined}>{o}</span>
              ))}
            </div>
          </Hl>
        </div>
      )
    case 'checks':
      return (
        <div className="flex flex-wrap gap-2">{label}
          <Hl mark={r.mark} className="min-w-0 flex-1">
            <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 py-0.5 sm:grid-cols-2">
              {r.options.map((o) => (
                <div key={o.label} className={cx('relative flex items-center gap-2 rounded px-1 text-[12px] text-slate-700', !!o.mark && 'bg-amber-100 ring-1 ring-amber-400')}>
                  <Check on={o.on} />{o.label}
                  <Mark n={o.mark} className="-right-2 -top-2.5 size-5 text-[10px]" />
                </div>
              ))}
            </div>
          </Hl>
        </div>
      )
    case 'toggle':
      return (
        <div className="flex flex-wrap items-start gap-2">{label}
          <Hl mark={r.mark}>
            <div className="flex items-center gap-2 px-0.5 py-0.5">
              <span className="relative h-4 w-7 rounded-full transition" style={{ background: r.on ? blue : '#cbd2dc' }}>
                <span className={cx('absolute top-0.5 size-3 rounded-full bg-white shadow', r.on ? 'left-3.5' : 'left-0.5')} />
              </span>
              {r.hint && <span className="text-[11px] text-slate-500">{r.hint}</span>}
            </div>
          </Hl>
        </div>
      )
    case 'input':
      return (
        <div className="flex flex-wrap gap-2">{label}
          <Hl mark={r.mark}><div className={cx('w-52 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[12px] text-slate-800', r.mono && 'font-mono')}>{r.value}</div></Hl>
        </div>
      )
    case 'button':
      return (
        <div className="flex justify-end pt-1">
          <Hl mark={r.mark}><span className="inline-block rounded-md px-3 py-1 text-[12px] font-medium text-white" style={{ background: blue }}>{r.label}</span></Hl>
        </div>
      )
    case 'table':
      return (
        <div>
          <div className="pb-1.5 text-[12px] font-medium text-slate-700">{r.label}</div>
          <div className="overflow-hidden rounded-md border border-slate-200 text-[11.5px]">
            <div className="grid bg-slate-50 font-medium text-slate-500" style={{ gridTemplateColumns: `repeat(${r.columns.length}, minmax(0, 1fr))` }}>
              {r.columns.map((c) => <div key={c} className="truncate px-2 py-1">{c}</div>)}
            </div>
            {r.rows.map((row, i) => (
              <div key={i} className={cx('relative grid border-t border-slate-200 text-slate-700', !!row.mark && 'bg-amber-50 ring-2 ring-inset ring-amber-400')} style={{ gridTemplateColumns: `repeat(${r.columns.length}, minmax(0, 1fr))` }}>
                {row.cells.map((c, j) => <div key={j} className={cx('truncate px-2 py-1', j === 0 && !!row.mark && 'font-medium')} style={j === 0 && row.mark ? { color: blue } : undefined}>{c}</div>)}
                <Mark n={row.mark} className="right-1 top-0.5 size-5 text-[10px]" />
              </div>
            ))}
          </div>
        </div>
      )
  }
}

const railIcons: Record<NonNullable<MockSpec['app']>, ReactNode[]> = {
  network: [<LayoutDashboard key="d" />, <Network key="t" />, <RouterIcon key="r" />, <Smartphone key="c" />, <Wifi key="w" />],
  os: [<LayoutDashboard key="d" />, <Network key="n" />, <Camera key="p" />, <DoorOpen key="a" />],
  protect: [<LayoutDashboard key="d" />, <Camera key="c" />],
  access: [<LayoutDashboard key="d" />, <DoorOpen key="a" />],
}

/** A drawn, annotated UniFi screen. */
export default function Mockup({ spec, caption }: { spec: MockSpec; caption?: string }) {
  const app = spec.app ?? 'network'
  return (
    <figure className="space-y-2">
      <div className="overflow-hidden rounded-xl bg-white text-slate-800 shadow-xl shadow-black/10 ring-1 ring-slate-300/70 dark:ring-white/10">
        {/* window chrome */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-100 px-3 py-1.5">
          <span className="size-2.5 rounded-full bg-red-400" /><span className="size-2.5 rounded-full bg-amber-400" /><span className="size-2.5 rounded-full bg-emerald-400" />
          <div className="ml-2 flex min-w-0 flex-1 items-center gap-1 truncate text-[11px] text-slate-500">
            <span className="font-semibold" style={{ color: blue }}>UniFi</span><span className="text-slate-400">·</span>{appLabel[app]}
            {spec.path.map((p, i) => <span key={i} className="flex items-center gap-1"><ChevronRight className="size-3 text-slate-400" /><span className={i === spec.path.length - 1 ? 'font-medium text-slate-700' : ''}>{p}</span></span>)}
          </div>
        </div>
        <div className="flex min-h-[220px]">
          {/* icon rail, settings gear at the bottom like the real app */}
          <div className="flex w-10 shrink-0 flex-col items-center gap-3 border-r border-slate-200 bg-slate-50 py-3 text-slate-400 [&_svg]:size-4">
            {railIcons[app]}
            <div className="flex-1" />
            <div className="relative rounded-md p-1" style={spec.path[0] === 'Settings' ? { color: blue, background: '#e6f0ff' } : undefined}>
              <Settings />
            </div>
          </div>
          {spec.menu && (
            <div className="hidden w-40 shrink-0 border-r border-slate-200 py-2 sm:block">
              {spec.menu.items.map((m) => {
                const active = m === spec.menu!.active
                return (
                  <div key={m} className="relative px-2 py-0.5">
                    <div className={cx('flex items-center gap-2 rounded-md px-2 py-1 text-[12px]', active ? 'font-medium' : 'text-slate-600', active && !!spec.menu!.mark && 'ring-2 ring-amber-400')}
                      style={active ? { color: blue, background: '#e6f0ff' } : undefined}>
                      {m === 'CyberSecure' ? <Shield className="size-3.5" /> : null}{m}
                    </div>
                    {active && <Mark n={spec.menu!.mark} className="-right-1 -top-1.5 size-5 text-[10px]" />}
                  </div>
                )
              })}
            </div>
          )}
          <div className="min-w-0 flex-1">
            {spec.tabs && (
              <div className="flex gap-4 overflow-x-auto border-b border-slate-200 px-4 pt-2 text-[12px]">
                {spec.tabs.items.map((x) => {
                  const active = x === spec.tabs!.active
                  return (
                    <div key={x} className={cx('relative whitespace-nowrap border-b-2 pb-1.5 pt-1', active ? 'font-medium' : 'border-transparent text-slate-500', active && !!spec.tabs!.mark && 'rounded-t bg-amber-100 px-1')}
                      style={active ? { color: blue, borderColor: blue } : undefined}>
                      {x}
                      {active && <Mark n={spec.tabs!.mark} className="-right-3 -top-1 size-5 text-[10px]" />}
                    </div>
                  )
                })}
              </div>
            )}
            <div className={cx('space-y-3 p-4', spec.panel && 'ml-auto max-w-md border-l border-slate-200 bg-white shadow-[-8px_0_24px_-12px_rgba(0,0,0,.15)]')}>
              {spec.panel && <div className="border-b border-slate-200 pb-2 text-[13px] font-semibold">{spec.panel}</div>}
              {spec.rows.map((r, i) => <Row key={i} r={r} />)}
            </div>
          </div>
        </div>
      </div>
      <figcaption className="text-[11px] text-muted">
        {caption && <span className="text-[var(--text)]">{caption} · </span>}
        {t('Illustration; labels can differ slightly between UniFi versions.')}
      </figcaption>
    </figure>
  )
}
