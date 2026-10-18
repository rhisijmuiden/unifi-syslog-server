import { useEffect, useState } from 'react'
import { RefreshCw, Download, CheckCircle2, Sparkles, ExternalLink } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../App'
import { Button, Modal, Spinner, useToast } from './ui'
import { fmtBytes, fmtDuration, fmtNum, fmtTime } from '../lib/format'
import { t } from '../i18n'

interface InfoData {
  version: string; commit: string; build_date: string; repo: string; go: string; os: string; hostname: string; uptime_sec: number
  storage: { rows: number; bytes_on_disk: number; bytes_uncompressed: number; oldest: string; clickhouse_version: string }
  ingest: Record<string, number | string>
  syslog: { udp: string; tcp: string }
}
interface Check { current: string; latest: string; available: boolean; notes: string; url: string; published: string }

export default function InfoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth()
  const toast = useToast()
  const [info, setInfo] = useState<InfoData>()
  const [check, setCheck] = useState<Check>()
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState<string>()

  useEffect(() => { if (open) api.get<InfoData>('/info').then(setInfo).catch(() => {}) }, [open])

  const doCheck = async () => {
    setChecking(true)
    try { setCheck(await api.get<Check>('/update/check')) } catch (e) { toast('err', (e as Error).message) } finally { setChecking(false) }
  }

  const doUpdate = async () => {
    if (!confirm(t('Update to version {version}? The service will restart automatically afterwards.', { version: check?.latest ?? '' }))) return
    try {
      await api.post('/update/apply')
      setUpdating(t('Downloading update…'))
      const from = info?.version
      const poll = setInterval(async () => {
        try {
          const s = await api.get<{ running: boolean; state: string; version: string }>('/update/status')
          if (s.version !== from) {
            clearInterval(poll)
            setUpdating(undefined)
            toast('ok', t('Updated to {version}', { version: s.version }))
            setTimeout(() => window.location.reload(), 800)
            return
          }
          if (s.state) setUpdating(s.state)
          if (/^(error|fout)/i.test(s.state)) { clearInterval(poll); toast('err', s.state); setUpdating(undefined) }
        } catch { setUpdating(t('Service restarting…')) }
      }, 1500)
    } catch (e) { toast('err', (e as Error).message) }
  }

  const row = (k: string, v: React.ReactNode) => (
    <div className="flex justify-between gap-4 py-2 text-sm"><span className="text-muted">{k}</span><span className="text-right font-medium">{v}</span></div>
  )

  return (
    <Modal open={open} onClose={onClose} title={t('Info & updates')}>
      {!info ? <div className="grid place-items-center py-10"><Spinner /></div> : (
        <div className="space-y-5">
          <div className="rounded-2xl bg-gradient-to-br from-indigo-500/15 to-cyan-500/10 p-5 ring-1 ring-indigo-500/20">
            <div className="text-xs uppercase tracking-wide text-muted">{t('Current version')}</div>
            <div className="mt-1 text-3xl font-semibold grad-text">v{info.version}</div>
            <div className="mt-1 text-xs text-muted">{t('commit {commit} · built {date}', { commit: info.commit.slice(0, 8), date: info.build_date })}</div>
          </div>

          <div className="space-y-3">
            <div className="flex gap-2">
              <Button onClick={doCheck} loading={checking} icon={<RefreshCw className="size-4" />} className="flex-1">{t('Check for updates')}</Button>
              {check?.available && user.role === 'admin' && (
                <Button variant="primary" onClick={doUpdate} loading={!!updating} icon={<Download className="size-4" />} className="flex-1">{t('Update to v{version}', { version: check.latest })}</Button>
              )}
            </div>
            {updating && <div className="rounded-xl bg-indigo-500/10 px-4 py-3 text-sm text-indigo-400 ring-1 ring-indigo-500/20 flex items-center gap-2"><Spinner className="size-4" />{updating}</div>}
            {check && !check.available && <div className="flex items-center gap-2 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm text-emerald-500 ring-1 ring-emerald-500/30"><CheckCircle2 className="size-4" /> {t('You are running the latest version (v{version}).', { version: check.latest })}</div>}
            {check?.available && (
              <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm ring-1 ring-amber-500/30">
                <div className="flex items-center gap-2 font-medium text-amber-500"><Sparkles className="size-4" /> {t('Version {version} is available', { version: check.latest })}</div>
                {check.notes && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted scroll-thin">{check.notes}</pre>}
                <a href={check.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-400 hover:underline">{t('Release notes')} <ExternalLink className="size-3" /></a>
                {user.role !== 'admin' && <p className="mt-2 text-xs text-muted">{t('Only an admin can install the update.')}</p>}
              </div>
            )}
          </div>

          <div className="divide-y divide-[var(--border)]">
            {row(t('Server'), info.hostname)}
            {row(t('Platform'), `${info.os} · ${info.go}`)}
            {row(t('Uptime'), fmtDuration(info.uptime_sec))}
            {row(t('Syslog ports'), `UDP ${info.syslog.udp} · TCP ${info.syslog.tcp}`)}
            {row(t('Messages received'), fmtNum(Number(info.ingest.parsed)))}
            {row(t('Stored rows'), fmtNum(info.storage.rows))}
            {row(t('Storage (compressed)'), t('{used} of {total}', { used: fmtBytes(info.storage.bytes_on_disk), total: fmtBytes(info.storage.bytes_uncompressed) }))}
            {info.storage.rows > 0 && row(t('Oldest log'), fmtTime(info.storage.oldest))}
            {row('ClickHouse', info.storage.clickhouse_version)}
            {row(t('Source code'), <a className="text-indigo-400 hover:underline" href={`https://github.com/${info.repo}`} target="_blank" rel="noreferrer">github.com/{info.repo}</a>)}
          </div>
        </div>
      )}
    </Modal>
  )
}
