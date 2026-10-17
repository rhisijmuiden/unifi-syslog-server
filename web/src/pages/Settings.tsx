import { useEffect, useState } from 'react'
import { Settings as SettingsIcon, Save, KeyRound } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../App'
import { Button, Card, Field, Input, PageHeader, Spinner, useToast } from '../components/ui'

interface General { timezone: string; retention_days: number; base_url: string; instance_name: string }
const zones = ['Europe/Amsterdam', 'Europe/Brussels', 'Europe/London', 'Europe/Berlin', 'UTC', 'America/New_York', 'Asia/Singapore']

export default function SettingsPage() {
  const toast = useToast()
  const { user } = useAuth()
  const [g, setG] = useState<General>()
  const [busy, setBusy] = useState(false)
  const [pw, setPw] = useState({ current: '', new: '' })
  useEffect(() => { api.get<General>('/settings/general').then(setG) }, [])
  if (!g) return <div className="grid place-items-center py-24"><Spinner /></div>
  const save = async () => {
    setBusy(true)
    try { setG(await api.put<General>('/settings/general', g)); toast('ok', 'Instellingen opgeslagen') } catch (e) { toast('err', (e as Error).message) } finally { setBusy(false) }
  }
  const changePw = async () => {
    try { await api.post('/me/password', pw); setPw({ current: '', new: '' }); toast('ok', 'Wachtwoord gewijzigd') } catch (e) { toast('err', (e as Error).message) }
  }
  return (
    <>
      <PageHeader title="Instellingen" subtitle="Algemene instellingen van de server" icon={<SettingsIcon className="size-5" />}
        actions={<Button variant="primary" loading={busy} onClick={save} icon={<Save className="size-4" />}>Opslaan</Button>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Algemeen">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Naam van deze server"><Input value={g.instance_name} onChange={(e) => setG({ ...g, instance_name: e.target.value })} /></Field>
            <Field label="Tijdzone van apparaten" hint="UniFi stuurt tijden zonder zone (RFC 3164)">
              <Input list="tz" value={g.timezone} onChange={(e) => setG({ ...g, timezone: e.target.value })} />
              <datalist id="tz">{zones.map((z) => <option key={z} value={z} />)}</datalist>
            </Field>
            <Field label="Bewaartermijn logs (dagen)" hint="Oudere logs worden automatisch per dag verwijderd"><Input type="number" min={1} max={3650} value={g.retention_days} onChange={(e) => setG({ ...g, retention_days: Number(e.target.value) })} /></Field>
            <Field label="Publieke basis-URL" hint="Nodig voor SSO achter een reverse proxy, bv. https://syslog.bedrijf.nl"><Input value={g.base_url} onChange={(e) => setG({ ...g, base_url: e.target.value.trim() })} placeholder="http://server:8080" /></Field>
          </div>
        </Card>
        <Card title="UniFi koppelen" subtitle="Zo stuur je logs naar deze server">
          <ol className="list-decimal space-y-2 pl-4 text-sm text-muted">
            <li>Open de UniFi Network-app → <span className="text-[var(--text)]">Instellingen → CyberSecure / Systeem → Traffic &amp; Firewall logging</span> (afhankelijk van versie: <span className="text-[var(--text)]">Instellingen → Systeem → Logging</span>).</li>
            <li>Kies <span className="text-[var(--text)]">SIEM Server</span> of <span className="text-[var(--text)]">Remote Syslog</span> en vul het IP-adres van deze server in, poort <span className="font-mono text-[var(--text)]">514</span>.</li>
            <li>Zet het logniveau op Info of Debug en schakel firewall-logging in bij de gewenste regels.</li>
            <li>Bij locaties achter NAT: koppel het WAN-IP aan de locatie via <span className="text-[var(--text)]">Locaties</span>.</li>
          </ol>
        </Card>
        {user.provider === 'local' && (
          <Card title="Mijn wachtwoord">
            <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <Field label="Huidig wachtwoord"><Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
              <Field label="Nieuw wachtwoord"><Input type="password" value={pw.new} onChange={(e) => setPw({ ...pw, new: e.target.value })} /></Field>
              <Button onClick={changePw} disabled={!pw.current || pw.new.length < 10} icon={<KeyRound className="size-4" />}>Wijzigen</Button>
            </div>
          </Card>
        )}
      </div>
    </>
  )
}
