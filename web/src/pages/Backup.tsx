import { useEffect, useState } from 'react'
import { DatabaseBackup, Save, Play, Plus, Pencil, Trash2, PlugZap, RotateCcw, Download, Server, FolderOpen } from 'lucide-react'
import { api } from '../api'
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Spinner, Toggle, useAsync, useToast } from '../components/ui'
import { fmtBytes, fmtNum, fmtTime } from '../lib/format'

interface Target { id: string; name: string; type: string; host: string; port: number; username: string; password: string; private_key: string; host_key: string; path: string; skip_verify: boolean; enabled: boolean }
interface Settings { enabled: boolean; time: string; full_every_days: number; incremental_hours: number; keep_chains: number; include_logs: boolean; notify_to: string; notify_on: string; targets: Target[] }
interface Status { running: boolean; job: string; step: string; started: string; last_error: string; last_done: string }
interface Rec { id: string; kind: string; file: string; size: number; rows: number; status: string; message: string; targets: string; created_at: number }
interface Entry { name: string; kind: string; id: string; base_id: string; time: string; size: number }

const typeLabel: Record<string, string> = { ftp: 'FTP', ftps: 'FTPS (explicit)', 'ftps-implicit': 'FTPS (implicit)', scp: 'SCP (SSH)', local: 'Local folder' }
const blankTarget: Target = { id: '', name: '', type: 'scp', host: '', port: 0, username: '', password: '', private_key: '', host_key: '', path: '/backup/unify-syslog', skip_verify: false, enabled: true }

export default function Backup() {
  const toast = useToast()
  const [s, setS] = useState<Settings>()
  const [status, setStatus] = useState<Status>()
  const history = useAsync(() => api.get<Rec[]>('/backup/history'))
  const [edit, setEdit] = useState<{ t: Target; idx: number }>()
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)

  useEffect(() => { api.get<Settings>('/settings/backup').then(setS) }, [])
  useEffect(() => {
    let prevRunning = false
    const poll = () => api.get<Status>('/backup/status').then((st) => {
      setStatus(st)
      if (prevRunning && !st.running) {
        history.reload()
        if (st.last_error) toast('err', st.last_error)
        else toast('ok', 'Job completed')
      }
      prevRunning = st.running
    }).catch(() => {})
    poll()
    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!s) return <div className="grid place-items-center py-24"><Spinner /></div>
  const up = (p: Partial<Settings>) => setS({ ...s, ...p })
  const save = async (next = s) => {
    setBusy(true)
    try { setS(await api.put<Settings>('/settings/backup', next)); toast('ok', 'Backup settings saved') } catch (e) { toast('err', (e as Error).message) } finally { setBusy(false) }
  }
  const run = async (kind: string) => {
    try { setStatus(await api.post<Status>('/backup/run', { kind })) } catch (e) { toast('err', (e as Error).message) }
  }
  const saveTarget = () => {
    const targets = [...s.targets]
    if (edit!.idx >= 0) targets[edit!.idx] = edit!.t
    else targets.push(edit!.t)
    setEdit(undefined)
    save({ ...s, targets })
  }
  const testTarget = async () => {
    setTesting(true)
    try { const r = await api.post<{ message: string }>('/backup/test-target', edit!.t); toast('ok', r.message) } catch (e) { toast('err', (e as Error).message) } finally { setTesting(false) }
  }
  const t = edit?.t
  const upT = (p: Partial<Target>) => setEdit({ ...edit!, t: { ...edit!.t, ...p } })

  return (
    <>
      <PageHeader title="Backup & restore" subtitle="Full and incremental backups to FTP, FTPS or SCP" icon={<DatabaseBackup className="size-5" />}
        actions={<>
          <Button onClick={() => setRestoreOpen(true)} icon={<RotateCcw className="size-4" />}>Restore</Button>
          <Button onClick={() => run('incremental')} disabled={status?.running} icon={<Play className="size-4" />}>Incremental</Button>
          <Button variant="primary" onClick={() => run('full')} disabled={status?.running} icon={<Play className="size-4" />}>Full backup</Button>
        </>} />

      {status?.running && (
        <div className="mb-6 flex items-center gap-3 rounded-2xl bg-indigo-500/10 px-5 py-4 text-sm ring-1 ring-indigo-500/30">
          <Spinner className="size-4" /><span className="font-medium">{status.job}</span><span className="text-muted">{status.step}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card title="Schedule" className="xl:col-span-1" actions={<Button variant="primary" loading={busy} onClick={() => save()} icon={<Save className="size-4" />}>Save</Button>}>
          <div className="space-y-4">
            <Toggle checked={s.enabled} onChange={(enabled) => up({ enabled })} label="Automatic backups" />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Daily at"><Input type="time" value={s.time} onChange={(e) => up({ time: e.target.value })} /></Field>
              <Field label="Full every (days)"><Input type="number" min={1} value={s.full_every_days} onChange={(e) => up({ full_every_days: Number(e.target.value) })} /></Field>
              <Field label="Extra incremental every (hours)" hint="0 = daily only"><Input type="number" min={0} value={s.incremental_hours} onChange={(e) => up({ incremental_hours: Number(e.target.value) })} /></Field>
              <Field label="Chains to keep" hint="Number of full backups"><Input type="number" min={1} value={s.keep_chains} onChange={(e) => up({ keep_chains: Number(e.target.value) })} /></Field>
            </div>
            <Toggle checked={s.include_logs} onChange={(include_logs) => up({ include_logs })} label="Include log data" description="Off: configuration only (users, categories, settings)" />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Email report"><Select value={s.notify_on} onChange={(notify_on) => up({ notify_on })} options={[{ value: 'never', label: 'Never' }, { value: 'failure', label: 'On failure' }, { value: 'always', label: 'Always' }]} /></Field>
              <Field label="To"><Input value={s.notify_to} onChange={(e) => up({ notify_to: e.target.value })} placeholder="it@example.com" /></Field>
            </div>
          </div>
        </Card>

        <Card title="Remote targets" className="xl:col-span-2" subtitle="Every backup is also kept locally on the server"
          actions={<Button onClick={() => setEdit({ t: { ...blankTarget }, idx: -1 })} icon={<Plus className="size-4" />}>Add target</Button>}>
          {!s.targets.length ? <p className="py-6 text-center text-sm text-muted">No remote backup targets yet.</p> : (
            <ul className="divide-y divide-[var(--border)]">
              {s.targets.map((tg, i) => (
                <li key={tg.id || i} className="flex items-center justify-between gap-3 py-3">
                  <div className="flex items-center gap-3">
                    <div className="grid size-9 place-items-center rounded-xl bg-[var(--panel-2)] text-muted">{tg.type === 'local' ? <FolderOpen className="size-4" /> : <Server className="size-4" />}</div>
                    <div>
                      <div className="flex items-center gap-2 font-medium">{tg.name || tg.host}<Badge>{typeLabel[tg.type]}</Badge>{!tg.enabled && <Badge>off</Badge>}</div>
                      <div className="font-mono text-xs text-muted">{tg.type === 'local' ? tg.path : `${tg.username}@${tg.host}${tg.port ? ':' + tg.port : ''}:${tg.path}`}</div>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => setEdit({ t: { ...tg }, idx: i })} className="cursor-pointer rounded-lg p-2 hover:bg-[var(--panel-2)]"><Pencil className="size-4" /></button>
                    <button onClick={() => { if (confirm('Delete?')) save({ ...s, targets: s.targets.filter((_, j) => j !== i) }) }} className="cursor-pointer rounded-lg p-2 text-red-500 hover:bg-red-500/10"><Trash2 className="size-4" /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="History" className="xl:col-span-3" pad={false}>
          {!history.data?.length ? <p className="py-8 text-center text-sm text-muted">No backups made yet.</p> : (
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr className="border-b border-app">
                  <th className="px-5 py-3 font-medium">Time</th><th className="px-3 py-3 font-medium">Type</th><th className="px-3 py-3 font-medium">Status</th><th className="px-3 py-3 font-medium text-right">Log rows</th>
                  <th className="px-3 py-3 font-medium text-right">Size</th><th className="px-3 py-3 font-medium">Uploaded to</th><th className="px-5 py-3" />
                </tr></thead>
                <tbody>{history.data.map((r) => (
                  <tr key={r.id} className="border-b border-app/60">
                    <td className="px-5 py-2.5 whitespace-nowrap">{fmtTime(r.created_at * 1000)}</td>
                    <td className="px-3 py-2.5">{r.kind === 'full' ? <Badge className="bg-indigo-500/15 text-indigo-400 ring-indigo-500/30">Full</Badge> : <Badge>Incremental</Badge>}</td>
                    <td className="px-3 py-2.5" title={r.message}>{r.status === 'ok' ? <span className="text-emerald-500">Succeeded</span> : r.status === 'running' ? <span className="text-indigo-400">Running</span> : <span className="text-red-500">Failed</span>}{r.message && <div className="max-w-xs truncate text-xs text-muted">{r.message}</div>}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(r.rows)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{fmtBytes(r.size)}</td>
                    <td className="px-3 py-2.5 text-muted">{r.targets || 'local only'}</td>
                    <td className="px-5 py-2.5 text-right">{r.status === 'ok' && <a href={`/api/backup/download/${r.file}`} title="Download" className="inline-block rounded-lg p-2 hover:bg-[var(--panel-2)]"><Download className="size-4" /></a>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Modal open={!!edit} onClose={() => setEdit(undefined)} title={edit?.idx === -1 ? 'Add backup target' : 'Edit backup target'}
        footer={<><Button onClick={testTarget} loading={testing} icon={<PlugZap className="size-4" />}>Test connection</Button><Button variant="primary" onClick={saveTarget}>Save</Button></>}>
        {t && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name"><Input value={t.name} onChange={(e) => upT({ name: e.target.value })} placeholder="Office NAS" /></Field>
              <Field label="Type"><Select value={t.type} onChange={(type) => upT({ type })} options={Object.entries(typeLabel).map(([value, label]) => ({ value, label }))} /></Field>
            </div>
            {t.type !== 'local' && (
              <div className="grid grid-cols-3 gap-3">
                <Field label="Host" className="col-span-2"><Input value={t.host} onChange={(e) => upT({ host: e.target.value.trim() })} /></Field>
                <Field label="Port"><Input type="number" value={t.port || ''} placeholder={t.type === 'scp' ? '22' : t.type === 'ftps-implicit' ? '990' : '21'} onChange={(e) => upT({ port: Number(e.target.value) })} /></Field>
                <Field label="User"><Input value={t.username} onChange={(e) => upT({ username: e.target.value })} /></Field>
                <Field label={t.type === 'scp' && t.private_key ? 'Key passphrase' : 'Password'} className="col-span-2"><Input type="password" value={t.password} autoComplete="new-password" onChange={(e) => upT({ password: e.target.value })} /></Field>
              </div>
            )}
            <Field label={t.type === 'local' ? 'Folder on this server' : 'Folder on the server'}><Input value={t.path} onChange={(e) => upT({ path: e.target.value })} /></Field>
            {t.type === 'scp' && <>
              <Field label="Private key (optional)" hint="OpenSSH format; ed25519 and RSA are supported"><textarea rows={4} className="input" value={t.private_key} onChange={(e) => upT({ private_key: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></Field>
              <Field label="Host key fingerprint (recommended)" hint="E.g. SHA256:abc…  (ssh-keyscan host | ssh-keygen -lf -)"><Input value={t.host_key} onChange={(e) => upT({ host_key: e.target.value.trim() })} /></Field>
            </>}
            {t.type.startsWith('ftps') && <Toggle checked={t.skip_verify} onChange={(skip_verify) => upT({ skip_verify })} label="Skip certificate verification" />}
            <Toggle checked={t.enabled} onChange={(enabled) => upT({ enabled })} label="Enabled" />
          </div>
        )}
      </Modal>

      <RestoreModal open={restoreOpen} onClose={() => setRestoreOpen(false)} targets={s.targets} />
    </>
  )
}

function RestoreModal({ open, onClose, targets }: { open: boolean; onClose: () => void; targets: Target[] }) {
  const toast = useToast()
  const [target, setTarget] = useState('local')
  const [list, setList] = useState<Entry[]>()
  const [err, setErr] = useState<string>()
  const [sel, setSel] = useState<string>()
  const [opts, setOpts] = useState({ config: true, logs: true })
  useEffect(() => {
    if (!open) return
    setList(undefined); setErr(undefined); setSel(undefined)
    api.get<Entry[]>('/backup/list?target=' + target).then(setList).catch((e) => setErr(e.message))
  }, [open, target])
  const go = async () => {
    const e = list?.find((x) => x.name === sel)
    if (!e) return
    if (!confirm(`Restore from ${e.name}?\n\n${opts.logs ? 'ALL current log data will be replaced. ' : ''}${opts.config ? 'The configuration will be replaced and the service restarted.' : ''}`)) return
    try { await api.post('/backup/restore', { target, name: e.name, ...opts }); toast('ok', 'Restore started'); onClose() } catch (er) { toast('err', (er as Error).message) }
  }
  return (
    <Modal open={open} onClose={onClose} title="Restore from backup" wide
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!sel || (!opts.config && !opts.logs)} onClick={go} icon={<RotateCcw className="size-4" />}>Restore</Button></>}>
      <div className="space-y-4">
        <Field label="Source"><Select value={target} onChange={setTarget} options={[{ value: 'local', label: 'This server' }, ...targets.map((t) => ({ value: t.id, label: `${t.name || t.host} (${typeLabel[t.type]})` }))]} /></Field>
        {err && <div className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-500 ring-1 ring-red-500/30">{err}</div>}
        {!list && !err ? <div className="grid place-items-center py-10"><Spinner /></div> : list && (
          <div className="max-h-72 overflow-y-auto rounded-xl ring-1 ring-[var(--border)] scroll-thin">
            {!list.length ? <p className="py-8 text-center text-sm text-muted">No backups found.</p> : list.map((e) => (
              <label key={e.name} className={'flex cursor-pointer items-center gap-3 border-b border-app/60 px-4 py-2.5 text-sm hover:bg-[var(--panel-2)] ' + (sel === e.name ? 'bg-indigo-500/10' : '')}>
                <input type="radio" checked={sel === e.name} onChange={() => setSel(e.name)} />
                <span className="flex-1">{fmtTime(e.time + 'Z')}</span>
                {e.kind === 'full' ? <Badge className="bg-indigo-500/15 text-indigo-400 ring-indigo-500/30">Full</Badge> : <Badge>Incremental</Badge>}
                <span className="w-20 text-right tabular-nums text-muted">{fmtBytes(e.size)}</span>
              </label>
            ))}
          </div>
        )}
        <p className="text-xs text-muted">Restoring an incremental backup automatically restores its full backup and all incremental backups in between.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="panel-2 rounded-xl p-3"><Toggle checked={opts.config} onChange={(config) => setOpts({ ...opts, config })} label="Configuration" description="Users, settings, categories" /></div>
          <div className="panel-2 rounded-xl p-3"><Toggle checked={opts.logs} onChange={(logs) => setOpts({ ...opts, logs })} label="Log data" description="Replaces all current logs" /></div>
        </div>
      </div>
    </Modal>
  )
}
