import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BellRing, Plus, Pencil, Trash2 } from 'lucide-react'
import { api } from '../api'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Toggle, cx, useAsync, useToast } from '../components/ui'
import { fmtTime } from '../lib/format'
import { t } from '../i18n'
import { kindInfo, severityColor, severityOptions, type Channel, type Severity } from './Notifications'

interface Rule { id?: number; name: string; query: string; threshold: number; window_minutes: number; cooldown_minutes: number; recipients: string; enabled: boolean; last_fired?: number; destinations: number[]; channels: number[]; severity: Severity; email: boolean }
interface Destination { id: number; name: string; kind: string; enabled: boolean }
const blank: Rule = { name: '', query: '', threshold: 10, window_minutes: 5, cooldown_minutes: 30, recipients: '', enabled: true, destinations: [], channels: [], severity: 'warning', email: true }

const presets: Partial<Rule>[] = [
  { name: 'Brute-force SSH', query: 'category:auth event:login_failed', threshold: 20, window_minutes: 5 },
  { name: 'Critical IPS alert', query: 'category:ips severity:<=crit', threshold: 1, window_minutes: 5, severity: 'critical' },
  { name: 'Port scan on WAN', query: 'category:firewall action:block in:eth*', threshold: 500, window_minutes: 5 },
  { name: 'Switch port down', query: 'category:switch event:link_down', threshold: 1, window_minutes: 5 },
]

export default function Alerts() {
  const toast = useToast()
  const rules = useAsync(() => api.get<Rule[]>('/alerts'))
  const dests = useAsync(() => api.get<Destination[]>('/forward'))
  const destName = (id: number) => dests.data?.find((d) => d.id === id)?.name
  const chans = useAsync(() => api.get<Channel[]>('/notify'))
  const chan = (id: number) => chans.data?.find((c) => c.id === id)
  const [edit, setEdit] = useState<Rule>()
  const save = async () => {
    try {
      if (edit!.id) await api.put('/alerts/' + edit!.id, edit)
      else await api.post('/alerts', edit)
      setEdit(undefined); rules.reload(); toast('ok', t('Alert saved'))
    } catch (e) { toast('err', (e as Error).message) }
  }
  const num = (k: keyof Rule) => (e: React.ChangeEvent<HTMLInputElement>) => setEdit({ ...edit!, [k]: Number(e.target.value) })

  return (
    <>
      <PageHeader title={t('Alerts')} subtitle={t('Get a notification as soon as a filter exceeds a threshold')} icon={<BellRing className="size-5" />}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit({ ...blank })}>{t('New alert')}</Button>} />
      <Card pad={false}>
        {rules.loading && !rules.data ? <div className="grid place-items-center py-16"><Spinner /></div>
          : !rules.data?.length ? (
            <Empty icon={<BellRing className="size-8" />} title={t('No alerts yet')} text={t('Start with an example:')} action={
              <div className="flex flex-wrap justify-center gap-2">{presets.map((p) => <Button key={p.name} onClick={() => setEdit({ ...blank, ...p, name: t(p.name!) })}>{t(p.name!)}</Button>)}</div>
            } />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {rules.data.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">{r.name}<Badge className={severityColor[r.severity ?? 'warning']}>{severityOptions().find((s) => s.value === (r.severity ?? 'warning'))!.label}</Badge>{!r.enabled && <Badge>{t('off')}</Badge>}</div>
                    <code className="mt-1 block truncate font-mono text-xs text-muted">{r.query}</code>
                    <div className="mt-1 text-xs text-muted">{t('≥ {n} in {min} min · to {to}', { n: r.threshold, min: r.window_minutes, to: r.email === false ? t('no e-mail') : r.recipients || t('default recipient') })}{r.last_fired ? ' · ' + t('last {time}', { time: fmtTime(r.last_fired * 1000) }) : ''}</div>
                    {(r.channels ?? []).length > 0 && <div className="mt-1 flex flex-wrap gap-1">{r.channels.map((id) => { const c = chan(id); return c && <Badge key={id} className="ring-1" color={kindInfo(c.kind).color}>{c.name}</Badge> })}</div>}
                    {(r.destinations ?? []).length > 0 && <div className="mt-1 flex flex-wrap gap-1">{r.destinations.map((id) => destName(id) && <Badge key={id} className="bg-indigo-500/10 text-indigo-400 ring-indigo-500/30">{destName(id)}</Badge>)}</div>}
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => setEdit(r)} className="cursor-pointer rounded-lg p-2 hover:bg-[var(--panel-2)]"><Pencil className="size-4" /></button>
                    <button onClick={async () => { if (confirm(t('Delete?'))) { await api.del('/alerts/' + r.id); rules.reload() } }} className="cursor-pointer rounded-lg p-2 text-red-500 hover:bg-red-500/10"><Trash2 className="size-4" /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Card>
      <p className="mt-3 text-xs text-muted">{t('Alerts are evaluated every minute and sent by e-mail, to the chosen notification channels and to the chosen forwarding destinations.')}</p>

      <Modal open={!!edit} onClose={() => setEdit(undefined)} title={edit?.id ? t('Edit alert') : t('New alert')}
        footer={<><Button onClick={() => setEdit(undefined)}>{t('Cancel')}</Button><Button variant="primary" onClick={save} disabled={!edit?.name || !edit?.query}>{t('Save')}</Button></>}>
        {edit && (
          <div className="space-y-4">
            <Field label={t('Name')}><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label={t('Filter')}><Input className="font-mono" value={edit.query} onChange={(e) => setEdit({ ...edit, query: e.target.value })} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={t('Threshold')}><Input type="number" min={1} value={edit.threshold} onChange={num('threshold')} /></Field>
              <Field label={t('Window (min)')}><Input type="number" min={1} value={edit.window_minutes} onChange={num('window_minutes')} /></Field>
              <Field label={t('Cooldown (min)')}><Input type="number" min={1} value={edit.cooldown_minutes} onChange={num('cooldown_minutes')} /></Field>
            </div>
            <Field label={t('Severity')} hint={t('Channels can skip lower severities, e.g. SMS only for critical alerts')}>
              <Select value={edit.severity ?? 'warning'} onChange={(v) => setEdit({ ...edit, severity: v as Severity })} options={severityOptions()} />
            </Field>
            <Toggle checked={edit.email ?? true} onChange={(email) => setEdit({ ...edit, email })} label={t('Send e-mail')} />
            {(edit.email ?? true) && <Field label={t('Recipients')} hint={t('Comma-separated. Empty = default recipient from the mail settings.')}><Input value={edit.recipients} onChange={(e) => setEdit({ ...edit, recipients: e.target.value })} placeholder="noc@example.com" /></Field>}
            <Field label={t('Notification channels')} hint={(chans.data ?? []).length ? t('Channels with a higher minimum severity skip this alert') : <Link to="/notifications" className="text-indigo-400 hover:underline">{t('Add Teams, Slack, Telegram or SMS under Notification channels')}</Link>}>
              <div className="flex flex-wrap gap-1.5">
                {(chans.data ?? []).map((c) => {
                  const on = (edit.channels ?? []).includes(c.id)
                  return (
                    <button key={c.id} type="button" onClick={() => setEdit({ ...edit, channels: on ? edit.channels.filter((x) => x !== c.id) : [...(edit.channels ?? []), c.id] })}
                      className={cx('flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs ring-1 transition cursor-pointer', on ? 'bg-indigo-500/15 text-indigo-400 ring-indigo-500/40' : 'ring-[var(--border)] text-muted hover:text-[var(--text)]')}>
                      <span className="[&_svg]:size-3.5" style={{ color: kindInfo(c.kind).color }}>{kindInfo(c.kind).icon}</span>{c.name}{!c.enabled && ' (' + t('off') + ')'}
                    </button>
                  )
                })}
              </div>
            </Field>
            {(dests.data ?? []).length > 0 && (
              <Field label={t('Also send to')} hint={t('Forwarding destinations that receive the alert, e.g. Microsoft Sentinel')}>
                <div className="flex flex-wrap gap-1.5">
                  {dests.data!.map((d) => {
                    const on = (edit.destinations ?? []).includes(d.id)
                    return (
                      <button key={d.id} type="button" onClick={() => setEdit({ ...edit, destinations: on ? edit.destinations.filter((x) => x !== d.id) : [...(edit.destinations ?? []), d.id] })}
                        className={'rounded-lg px-2.5 py-1 text-xs ring-1 transition cursor-pointer ' + (on ? 'bg-indigo-500/15 text-indigo-400 ring-indigo-500/40' : 'ring-[var(--border)] text-muted hover:text-[var(--text)]')}>
                        {d.name}{!d.enabled && ' (' + t('off') + ')'}
                      </button>
                    )
                  })}
                </div>
              </Field>
            )}
            <Toggle checked={edit.enabled} onChange={(enabled) => setEdit({ ...edit, enabled })} label={t('Enabled')} />
          </div>
        )}
      </Modal>
    </>
  )
}
