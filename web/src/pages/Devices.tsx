import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Router as RouterIcon, Search, Wifi, Network, Shield, Server } from 'lucide-react'
import { api } from '../api'
import { Badge, Card, Empty, PageHeader, Select, Spinner, useAsync } from '../components/ui'
import { fmtAgo, fmtNum } from '../lib/format'

interface Device { hostname: string; model: string; mac: string; version: string; source_ip: string; site: string; last_seen: string; count: number; errors: number }

function kind(d: Device) {
  const m = (d.model || d.hostname).toUpperCase()
  if (/^(U6|U7|UAP|UAL|UK|E7|U-?LTE|UWB|UMA|AC)/.test(m)) return { label: 'Access point', icon: <Wifi className="size-4" /> }
  if (/^(US|USW|USL|ECS)/.test(m)) return { label: 'Switch', icon: <Network className="size-4" /> }
  if (/(UDM|UDR|UXG|UCG|USG|GATEWAY|UDW|EFG|CLOUD)/.test(m)) return { label: 'Gateway', icon: <Shield className="size-4" /> }
  return { label: 'Overig', icon: <Server className="size-4" /> }
}

export default function Devices() {
  const [days, setDays] = useState('7')
  const [q, setQ] = useState('')
  const nav = useNavigate()
  const { data, loading } = useAsync(() => api.get<Device[]>('/devices?days=' + days), [days])
  const list = useMemo(() => (data ?? []).filter((d) => !q || `${d.hostname} ${d.model} ${d.mac} ${d.source_ip} ${d.site}`.toLowerCase().includes(q.toLowerCase())), [data, q])
  const stale = (d: Device) => Date.now() - new Date(d.last_seen).getTime() > 3600e3

  return (
    <>
      <PageHeader title="Apparaten" subtitle="UniFi-gateways, switches en accesspoints die logs sturen" icon={<RouterIcon className="size-5" />}
        actions={<>
          <div className="relative"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoeken…" className="input !pl-9 w-56" /></div>
          <Select value={days} onChange={setDays} className="w-44" options={[{ value: '1', label: 'Laatste 24 uur' }, { value: '7', label: 'Laatste 7 dagen' }, { value: '30', label: 'Laatste 30 dagen' }]} />
        </>} />
      <Card pad={false}>
        {loading && !data ? <div className="grid place-items-center py-20"><Spinner /></div>
          : !list.length ? <Empty icon={<RouterIcon className="size-8" />} title="Nog geen apparaten" text="Stel in de UniFi Network-app bij Instellingen → Systeem → Logging een externe syslog-server in met het IP van deze server, poort 514." />
          : (
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr className="border-b border-app">
                  <th className="px-5 py-3 font-medium">Apparaat</th><th className="px-3 py-3 font-medium">Type</th><th className="px-3 py-3 font-medium">Firmware</th>
                  <th className="px-3 py-3 font-medium">MAC</th><th className="px-3 py-3 font-medium">Bron-IP</th><th className="px-3 py-3 font-medium">Locatie</th>
                  <th className="px-3 py-3 font-medium text-right">Berichten</th><th className="px-3 py-3 font-medium text-right">Fouten</th><th className="px-5 py-3 font-medium">Laatst gezien</th>
                </tr></thead>
                <tbody>
                  {list.map((d) => {
                    const k = kind(d)
                    return (
                      <tr key={d.hostname + d.mac} onClick={() => nav('/logs?' + new URLSearchParams({ q: d.mac ? `mac:${d.mac}` : `host:"${d.hostname}"`, preset: '24h' }))} className="cursor-pointer border-b border-app/60 hover:bg-[var(--panel-2)]">
                        <td className="px-5 py-2.5"><div className="font-medium">{d.hostname}</div>{d.model && d.model !== d.hostname && <div className="text-xs text-muted">{d.model}</div>}</td>
                        <td className="px-3 py-2.5"><span className="inline-flex items-center gap-1.5 text-muted">{k.icon}{k.label}</span></td>
                        <td className="px-3 py-2.5 font-mono text-xs">{d.version}</td>
                        <td className="px-3 py-2.5 font-mono text-xs">{d.mac}</td>
                        <td className="px-3 py-2.5 font-mono text-xs">{d.source_ip}</td>
                        <td className="px-3 py-2.5">{d.site === 'default' ? <span className="text-muted">Standaard</span> : d.site}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{fmtNum(d.count)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{d.errors ? <span className="text-orange-500">{fmtNum(d.errors)}</span> : 0}</td>
                        <td className="px-5 py-2.5 whitespace-nowrap">{stale(d) ? <Badge className="bg-amber-500/15 text-amber-500 ring-amber-500/30">{fmtAgo(d.last_seen)}</Badge> : <span className="text-emerald-500">{fmtAgo(d.last_seen)}</span>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </>
  )
}
