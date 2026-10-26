import { useEffect } from 'react'
import { Link, Navigate, NavLink, useParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BookOpen } from 'lucide-react'
import { Badge, Card, PageHeader, cx } from '../components/ui'
import { catColor, catLabel } from '../lib/format'
import { t } from '../i18n'
import { guides, type Guide } from '../howto/guides'

function GuideIcon({ g, className }: { g: Guide; className?: string }) {
  return (
    <span className={cx('grid place-items-center rounded-xl ring-1 [&_svg]:size-4', className)}
      style={{ color: g.color, background: g.color + '1f', boxShadow: `inset 0 0 0 1px ${g.color}40` }}>{g.icon}</span>
  )
}

function Overview() {
  return (
    <>
      <PageHeader title={t('How-to guides')} subtitle={t('Set up UniFi so every type of log reaches this server')} icon={<BookOpen className="size-5" />} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
        {guides.map((g, i) => (
          <Link key={g.id} to={g.id} className={cx('panel group flex gap-4 rounded-2xl p-5 shadow-sm transition hover:-translate-y-0.5 hover:ring-1 hover:ring-indigo-400/50 fade-in', i === 0 && 'md:col-span-2 2xl:col-span-3 bg-gradient-to-r from-indigo-500/10 to-cyan-500/5')}>
            <GuideIcon g={g} className="size-10 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2 font-medium">{g.title()}<ArrowRight className="size-4 text-muted opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" /></div>
              <p className="text-sm text-muted">{g.summary()}</p>
              {g.categories.length > 0 && (
                <div className="flex flex-wrap gap-1.5">{g.categories.map((c) => <Badge key={c} color={catColor(c)}>{catLabel(c)}</Badge>)}</div>
              )}
            </div>
          </Link>
        ))}
      </div>
    </>
  )
}

function GuidePage({ g }: { g: Guide }) {
  const i = guides.indexOf(g)
  const next = guides[i + 1]
  useEffect(() => { document.querySelector('main')?.scrollTo(0, 0) }, [])
  return (
    <>
      <div className="mb-3">
        <Link to="/howto" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-[var(--text)]"><ArrowLeft className="size-4" />{t('All guides')}</Link>
      </div>
      <PageHeader title={g.title()} subtitle={g.summary()} icon={<span className="[&_svg]:size-5" style={{ color: g.color }}>{g.icon}</span>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[260px_minmax(0,1fr)]">
        <nav className="hidden xl:block">
          <div className="sticky top-6 space-y-0.5">
            {guides.map((x) => (
              <NavLink key={x.id} to={'/howto/' + x.id}
                className={({ isActive }) => cx('flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition [&_svg]:size-4',
                  isActive ? 'bg-[var(--panel)] font-medium ring-1 ring-[var(--border)]' : 'text-muted hover:bg-[var(--panel-2)] hover:text-[var(--text)]')}>
                <span className="shrink-0" style={{ color: x.color }}>{x.icon}</span><span className="leading-snug">{x.title()}</span>
              </NavLink>
            ))}
          </div>
        </nav>
        <div className="min-w-0 space-y-6">
          <Card><div className="max-w-4xl space-y-8">{g.body()}</div></Card>
          {next && (
            <Link to={'/howto/' + next.id} className="panel flex items-center gap-4 rounded-2xl p-4 transition hover:ring-1 hover:ring-indigo-400/50">
              <GuideIcon g={next} className="size-9 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-muted">{t('Next guide')}</div>
                <div className="font-medium">{next.title()}</div>
              </div>
              <ArrowRight className="size-4 text-muted" />
            </Link>
          )}
        </div>
      </div>
    </>
  )
}

export default function HowTo() {
  const { id } = useParams()
  if (!id) return <Overview />
  const g = guides.find((x) => x.id === id)
  return g ? <GuidePage key={g.id} g={g} /> : <Navigate to="/howto" replace />
}
