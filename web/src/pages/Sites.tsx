import { useState } from 'react'
import { MapPin, Plus, Trash2, Save } from 'lucide-react'
import { api } from '../api'
import { Button, Card, Empty, Field, Input, PageHeader, Spinner, useAsync, useToast } from '../components/ui'
import { fmtAgo } from '../lib/format'

interface Source { ip: string; name: string; site: string; hostname: string; model: string; last_seen: number; first_seen: number }
interface Range { id: number; site: string; cidr: string }

export default function Sites() {
  const toast = useToast()
  const sources = useAsync(() => api.get<Source[]>('/sources'))
  const ranges = useAsync(() => api.get<Range[]>('/site-ranges'))
  const [nr, setNr] = useState({ site: '', cidr: '' })
  const [edits, setEdits] = useState<Record<string, { name: string; site: string }>>({})

  const addRange = async () => {
    try {
      await api.post('/site-ranges', nr)
      setNr({ site: '', cidr: '' })
      ranges.reload(); sources.reload()
      toast('ok', 'Netwerk toegevoegd')
    } catch (e) { toast('err', (e as Error).message) }
  }
  const saveSource = async (ip: string) => {
    const e = edits[ip]
    try {
      await api.put('/sources/' + encodeURIComponent(ip), e)
      setEdits(({ [ip]: _, ...rest }) => rest)
      sources.reload()
      toast('ok', 'Opgeslagen')
    } catch (err) { toast('err', (err as Error).message) }
  }
  const siteNames = [...new Set([...(ranges.data ?? []).map((r) => r.site), ...(sources.data ?? []).map((s) => s.site)])].filter((s) => s && s !== 'default')

  return (
    <>
      <PageHeader title="Locaties" subtitle="Koppel binnenkomende logs aan je vestigingen" icon={<MapPin className="size-5" />} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-2" title="Netwerken per locatie" subtitle="Afzenders uit deze netwerken (bv. het WAN-adres van een vestiging) krijgen automatisch deze locatie">
          <div className="mb-4 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <Field label="Locatie"><Input list="sites" value={nr.site} onChange={(e) => setNr({ ...nr, site: e.target.value })} placeholder="Hoofdkantoor" /></Field>
            <Field label="Netwerk (CIDR)"><Input value={nr.cidr} onChange={(e) => setNr({ ...nr, cidr: e.target.value })} placeholder="84.12.34.56/32" /></Field>
            <Button variant="primary" onClick={addRange} disabled={!nr.site || !nr.cidr} icon={<Plus className="size-4" />} />
          </div>
          <datalist id="sites">{siteNames.map((s) => <option key={s} value={s} />)}</datalist>
          {!ranges.data?.length ? <p className="py-4 text-center text-sm text-muted">Nog geen netwerken ingesteld.</p> : (
            <ul className="divide-y divide-[var(--border)]">
              {ranges.data.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2.5 text-sm">
                  <span><span className="font-medium">{r.site}</span> <span className="ml-2 font-mono text-xs text-muted">{r.cidr}</span></span>
                  <button onClick={async () => { await api.del('/site-ranges/' + r.id); ranges.reload() }} className="cursor-pointer rounded-lg p-1.5 text-red-500 hover:bg-red-500/10"><Trash2 className="size-4" /></button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="xl:col-span-3" title="Afzenders" subtitle="Elk IP-adres dat syslog stuurt. Geef het een naam en locatie." pad={false}>
          {sources.loading && !sources.data ? <div className="grid place-items-center py-16"><Spinner /></div>
            : !sources.data?.length ? <Empty icon={<MapPin className="size-8" />} title="Nog geen afzenders" text="Zodra een UniFi-apparaat logs stuurt verschijnt het hier." />
            : (
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr className="border-b border-app">
                    <th className="px-5 py-3 font-medium">IP-adres</th><th className="px-3 py-3 font-medium">Naam</th><th className="px-3 py-3 font-medium">Locatie</th><th className="px-3 py-3 font-medium">Laatst gezien</th><th className="px-5 py-3" />
                  </tr></thead>
                  <tbody>
                    {sources.data.map((s) => {
                      const e = edits[s.ip] ?? { name: s.name, site: s.site === 'default' ? '' : s.site }
                      const dirty = !!edits[s.ip]
                      return (
                        <tr key={s.ip} className="border-b border-app/60">
                          <td className="px-5 py-2"><div className="font-mono text-xs">{s.ip}</div><div className="text-[11px] text-muted">{s.hostname}</div></td>
                          <td className="px-3 py-2"><Input value={e.name} placeholder={s.hostname} onChange={(ev) => setEdits({ ...edits, [s.ip]: { ...e, name: ev.target.value } })} className="!py-1.5" /></td>
                          <td className="px-3 py-2"><Input list="sites" value={e.site} placeholder="Standaard" onChange={(ev) => setEdits({ ...edits, [s.ip]: { ...e, site: ev.target.value } })} className="!py-1.5" /></td>
                          <td className="px-3 py-2 whitespace-nowrap text-xs text-muted">{fmtAgo(s.last_seen * 1000)}</td>
                          <td className="px-5 py-2 text-right">{dirty && <Button variant="primary" onClick={() => saveSource(s.ip)} icon={<Save className="size-4" />} />}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <p className="px-5 py-3 text-xs text-muted">Een gewijzigde locatie geldt voor nieuwe berichten; bestaande logs houden hun oorspronkelijke locatie.</p>
              </div>
            )}
        </Card>
      </div>
    </>
  )
}
