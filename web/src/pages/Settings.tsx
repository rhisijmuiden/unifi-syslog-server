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
    try { setG(await api.put<General>('/settings/general', g)); toast('ok', 'Settings saved') } catch (e) { toast('err', (e as Error).message) } finally { setBusy(false) }
  }
  const changePw = async () => {
    try { await api.post('/me/password', pw); setPw({ current: '', new: '' }); toast('ok', 'Password changed') } catch (e) { toast('err', (e as Error).message) }
  }
  return (
    <>
      <PageHeader title="Settings" subtitle="General server settings" icon={<SettingsIcon className="size-5" />}
        actions={<Button variant="primary" loading={busy} onClick={save} icon={<Save className="size-4" />}>Save</Button>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="General">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Server name"><Input value={g.instance_name} onChange={(e) => setG({ ...g, instance_name: e.target.value })} /></Field>
            <Field label="Device time zone" hint="UniFi sends timestamps without a zone (RFC 3164)">
              <Input list="tz" value={g.timezone} onChange={(e) => setG({ ...g, timezone: e.target.value })} />
              <datalist id="tz">{zones.map((z) => <option key={z} value={z} />)}</datalist>
            </Field>
            <Field label="Log retention (days)" hint="Older logs are deleted automatically, one day at a time"><Input type="number" min={1} max={3650} value={g.retention_days} onChange={(e) => setG({ ...g, retention_days: Number(e.target.value) })} /></Field>
            <Field label="Public base URL" hint="Required for SSO behind a reverse proxy, e.g. https://syslog.example.com"><Input value={g.base_url} onChange={(e) => setG({ ...g, base_url: e.target.value.trim() })} placeholder="http://server:8080" /></Field>
          </div>
        </Card>
        <Card title="Connect UniFi" subtitle="How to send logs to this server">
          <ol className="list-decimal space-y-2 pl-4 text-sm text-muted">
            <li>Open the UniFi Network app → <span className="text-[var(--text)]">Settings → CyberSecure / System → Traffic &amp; Firewall logging</span> (depending on version: <span className="text-[var(--text)]">Settings → System → Logging</span>).</li>
            <li>Choose <span className="text-[var(--text)]">SIEM Server</span> or <span className="text-[var(--text)]">Remote Syslog</span> and enter the IP address of this server, port <span className="font-mono text-[var(--text)]">514</span>.</li>
            <li>Set the log level to Info or Debug and enable firewall logging on the rules you want.</li>
            <li>For sites behind NAT: map the WAN IP to the site under <span className="text-[var(--text)]">Sites</span>.</li>
          </ol>
        </Card>
        {user.provider === 'local' && (
          <Card title="My password">
            <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <Field label="Current password"><Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
              <Field label="New password"><Input type="password" value={pw.new} onChange={(e) => setPw({ ...pw, new: e.target.value })} /></Field>
              <Button onClick={changePw} disabled={!pw.current || pw.new.length < 10} icon={<KeyRound className="size-4" />}>Change</Button>
            </div>
          </Card>
        )}
      </div>
    </>
  )
}
