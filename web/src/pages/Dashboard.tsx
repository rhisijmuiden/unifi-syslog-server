import { useNavigate } from 'react-router-dom'
import { Activity, ShieldX, Siren, TriangleAlert, LayoutDashboard, Gauge } from 'lucide-react'
import { api, type Bucket, type TopItem } from '../api'
import { Card, PageHeader, Spinner, Stat, useAsync } from '../components/ui'
import { BarList, Timeline } from '../components/charts'
import { RangePicker, RefreshButton, SiteFilter, toRange, useUrlState } from '../components/Filters'
import { catColor, catLabel, fmtCompact, fmtNum, severityLabel } from '../lib/format'

interface Dash {
  overview: { total: number; blocked: number; threats: number; errors: number; by_category: TopItem[]; by_site: TopItem[]; by_severity: TopItem[]; timeline: Bucket[]; step_sec: number }
  top: Record<string, TopItem[]>
  ingest: Record<string, number>
}

export default function Dashboard() {
  const [st, set] = useUrlState({ preset: '24h', from: '', to: '', site: '' })
  const nav = useNavigate()
  const { data, loading, reload } = useAsync(() => {
    const r = toRange(st)
    const q = new URLSearchParams({ from: r.from.toISOString(), to: r.to.toISOString() })
    if (st.site) q.set('sites', st.site)
    return api.get<Dash>('/dashboard?' + q)
  }, [st.preset, st.from, st.to, st.site])

  const go = (query: string, extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({ q: query, preset: st.preset, ...extra })
    if (st.preset === 'custom') { q.set('from', st.from); q.set('to', st.to) }
    if (st.site) q.set('site', st.site)
    nav('/logs?' + q)
  }
  const o = data?.overview

  return (
    <>
      <PageHeader title="Overzicht" subtitle="Alle UniFi-locaties in één oogopslag" icon={<LayoutDashboard className="size-5" />}
        actions={<>
          <SiteFilter value={st.site} onChange={(site) => set({ site })} />
          <RangePicker value={st} onChange={(r) => set({ preset: r.preset, from: r.from ?? '', to: r.to ?? '' })} />
          <RefreshButton onClick={reload} loading={loading} />
        </>} />

      {!data ? <div className="grid place-items-center py-24"><Spinner className="size-8" /></div> : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Stat label="Berichten" value={fmtCompact(o!.total)} sub={fmtNum(o!.total) + ' in deze periode'} icon={<Activity className="size-5" />} accent="#3987e5" />
            <Stat label="Geblokkeerd" value={fmtCompact(o!.blocked)} sub="door de firewall" icon={<ShieldX className="size-5" />} accent="#e66767" />
            <Stat label="Bedreigingen" value={fmtCompact(o!.threats)} sub="IPS/IDS-meldingen" icon={<Siren className="size-5" />} accent="#d95926" />
            <Stat label="Fouten" value={fmtCompact(o!.errors)} sub="ernst error of hoger" icon={<TriangleAlert className="size-5" />} accent="#c98500" />
            <Stat label="Ingest" value={fmtCompact(data.ingest.parsed)} sub={`${fmtNum(data.ingest.dropped)} verloren · ${fmtNum(data.ingest.insert_errors)} schrijffouten`} icon={<Gauge className="size-5" />} accent="#199e70" />
          </div>

          <Card title="Berichten per categorie" subtitle="Klik op een balk om die periode in de logs te openen">
            <Timeline buckets={o!.timeline ?? []} stepSec={o!.step_sec} range={toRange(st)} onSelect={(f, t) => go('', { preset: 'custom', from: localIso(f), to: localIso(t) })} />
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card title="Categorieën"><BarList mono={false} items={o!.by_category} color={catColor} format={catLabel} onClick={(k) => go(`category:${k}`)} /></Card>
            <Card title="Geblokkeerde bronnen" subtitle="Top IP-adressen die door de firewall zijn tegengehouden">
              <BarList items={data.top.blocked_src} color="#e66767" onClick={(k) => go(`category:firewall action:block src:${k}`)} />
            </Card>
            <Card title="Geblokkeerde poorten"><BarList items={data.top.blocked_dport} color="#e66767" format={portName} onClick={(k) => go(`category:firewall action:block dport:${k}`)} /></Card>
            <Card title="IPS-signaturen"><BarList items={data.top.ips_rules} color="#d95926" empty="Geen bedreigingen gedetecteerd" onClick={(k) => go(`category:ips rule:"${k}"`)} /></Card>
            <Card title="Firewallregels"><BarList items={data.top.fw_rules} color="#e66767" onClick={(k) => go(`category:firewall rule:"${k}"`)} /></Card>
            <Card title="Actiefste Wi-Fi-clients"><BarList items={data.top.wifi_clients} color="#3987e5" onClick={(k) => go(`category:wifi client:${k}`)} /></Card>
            <Card title="SSID's"><BarList items={data.top.ssids} color="#3987e5" onClick={(k) => go(`ssid:"${k}"`)} /></Card>
            <Card title="DHCP-clients"><BarList items={data.top.dhcp_clients} color="#199e70" onClick={(k) => go(`category:dhcp client_name:"${k}"`)} /></Card>
            <Card title="Apparaten" subtitle="Meeste berichten"><BarList items={data.top.sources} color="#3987e5" onClick={(k) => go(`host:"${k}"`)} /></Card>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Ernst"><BarList mono={false} items={[...o!.by_severity].sort((a, b) => +a.key - +b.key)} color="#c98500" format={(k) => severityLabel[+k] ?? k} onClick={(k) => go(`severity:${k}`)} /></Card>
            <Card title="Locaties"><BarList mono={false} items={o!.by_site} format={(k) => (k === 'default' ? 'Standaard' : k)} onClick={(k) => go('', { site: k })} /></Card>
          </div>
        </div>
      )}
    </>
  )
}

const ports: Record<string, string> = { '22': 'SSH', '23': 'Telnet', '80': 'HTTP', '443': 'HTTPS', '445': 'SMB', '3389': 'RDP', '1433': 'MSSQL', '3306': 'MySQL', '5060': 'SIP', '8080': 'HTTP-alt', '8443': 'HTTPS-alt', '6379': 'Redis', '53': 'DNS', '25': 'SMTP', '21': 'FTP' }
const portName = (p: string) => (ports[p] ? `${p} · ${ports[p]}` : p)
const localIso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
