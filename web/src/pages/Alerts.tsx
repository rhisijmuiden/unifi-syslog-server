import { useState } from 'react'
import { BellRing, Plus, Pencil, Trash2 } from 'lucide-react'
import { api } from '../api'
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Spinner, Toggle, useAsync, useToast } from '../components/ui'
import { fmtTime } from '../lib/format'

interface Rule { id?: number; name: string; query: string; threshold: number; window_minutes: number; cooldown_minutes: number; recipients: string; enabled: boolean; last_fired?: number }
const blank: Rule = { name: '', query: '', threshold: 10, window_minutes: 5, cooldown_minutes: 30, recipients: '', enabled: true }

const presets: Partial<Rule>[] = [
  { name: 'Brute-force SSH', query: 'category:auth event:login_failed', threshold: 20, window_minutes: 5 },
  { name: 'Kritieke IPS-melding', query: 'category:ips severity:<=crit', threshold: 1, window_minutes: 5 },
  { name: 'Poort-scan op WAN', query: 'category:firewall action:block in:eth*', threshold: 500, window_minutes: 5 },
  { name: 'Switchpoort down', query: 'category:switch event:link_down', threshold: 1, window_minutes: 5 },
]

export default function Alerts() {
  const toast = useToast()
  const rules = useAsync(() => api.get<Rule[]>('/alerts'))
  const [edit, setEdit] = useState<Rule>()
  const save = async () => {
    try {
      if (edit!.id) await api.put('/alerts/' + edit!.id, edit)
      else await api.post('/alerts', edit)
      setEdit(undefined); rules.reload(); toast('ok', 'Melding opgeslagen')
    } catch (e) { toast('err', (e as Error).message) }
  }
  const num = (k: keyof Rule) => (e: React.ChangeEvent<HTMLInputElement>) => setEdit({ ...edit!, [k]: Number(e.target.value) })

  return (
    <>
      <PageHeader title="Meldingen" subtitle="Ontvang een e-mail zodra een filter een drempel overschrijdt" icon={<BellRing className="size-5" />}
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit({ ...blank })}>Nieuwe melding</Button>} />
      <Card pad={false}>
        {rules.loading && !rules.data ? <div className="grid place-items-center py-16"><Spinner /></div>
          : !rules.data?.length ? (
            <Empty icon={<BellRing className="size-8" />} title="Nog geen meldingen" text="Begin met een voorbeeld:" action={
              <div className="flex flex-wrap justify-center gap-2">{presets.map((p) => <Button key={p.name} onClick={() => setEdit({ ...blank, ...p })}>{p.name}</Button>)}</div>
            } />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {rules.data.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">{r.name}{!r.enabled && <Badge>uit</Badge>}</div>
                    <code className="mt-1 block truncate font-mono text-xs text-muted">{r.query}</code>
                    <div className="mt-1 text-xs text-muted">≥ {r.threshold} in {r.window_minutes} min · naar {r.recipients || 'standaardontvanger'}{r.last_fired ? ` · laatst ${fmtTime(r.last_fired * 1000)}` : ''}</div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => setEdit(r)} className="cursor-pointer rounded-lg p-2 hover:bg-[var(--panel-2)]"><Pencil className="size-4" /></button>
                    <button onClick={async () => { if (confirm('Verwijderen?')) { await api.del('/alerts/' + r.id); rules.reload() } }} className="cursor-pointer rounded-lg p-2 text-red-500 hover:bg-red-500/10"><Trash2 className="size-4" /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Card>
      <p className="mt-3 text-xs text-muted">Meldingen worden elke minuut gecontroleerd en verstuurd via de ingestelde mailserver.</p>

      <Modal open={!!edit} onClose={() => setEdit(undefined)} title={edit?.id ? 'Melding bewerken' : 'Nieuwe melding'}
        footer={<><Button onClick={() => setEdit(undefined)}>Annuleren</Button><Button variant="primary" onClick={save} disabled={!edit?.name || !edit?.query}>Opslaan</Button></>}>
        {edit && (
          <div className="space-y-4">
            <Field label="Naam"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Filter"><Input className="font-mono" value={edit.query} onChange={(e) => setEdit({ ...edit, query: e.target.value })} /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Drempel"><Input type="number" min={1} value={edit.threshold} onChange={num('threshold')} /></Field>
              <Field label="Venster (min)"><Input type="number" min={1} value={edit.window_minutes} onChange={num('window_minutes')} /></Field>
              <Field label="Rust (min)"><Input type="number" min={1} value={edit.cooldown_minutes} onChange={num('cooldown_minutes')} /></Field>
            </div>
            <Field label="Ontvangers" hint="Komma-gescheiden. Leeg = standaardontvanger uit de mailinstellingen."><Input value={edit.recipients} onChange={(e) => setEdit({ ...edit, recipients: e.target.value })} placeholder="noc@bedrijf.nl" /></Field>
            <Toggle checked={edit.enabled} onChange={(enabled) => setEdit({ ...edit, enabled })} label="Ingeschakeld" />
          </div>
        )}
      </Modal>
    </>
  )
}
