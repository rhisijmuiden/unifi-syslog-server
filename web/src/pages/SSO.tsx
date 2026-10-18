import { useEffect, useState } from 'react'
import { KeyRound, Save, Copy } from 'lucide-react'
import { api } from '../api'
import { Button, Card, Field, Input, PageHeader, Select, Spinner, Toggle, useToast } from '../components/ui'

interface SSOSettings { enabled: boolean; tenant_id: string; client_id: string; client_secret: string; admin_group_id: string; allowed_group_id: string; auto_provision: boolean; default_role: string; button_label: string }

export default function SSO() {
  const toast = useToast()
  const [s, setS] = useState<SSOSettings>()
  const [redirect, setRedirect] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.get<{ settings: SSOSettings; redirect_uri: string }>('/settings/sso').then((r) => { setS(r.settings); setRedirect(r.redirect_uri) }) }, [])
  if (!s) return <div className="grid place-items-center py-24"><Spinner /></div>
  const up = (p: Partial<SSOSettings>) => setS({ ...s, ...p })
  const save = async () => {
    setBusy(true)
    try { setS(await api.put<SSOSettings>('/settings/sso', s)); toast('ok', 'SSO settings saved') } catch (e) { toast('err', (e as Error).message) } finally { setBusy(false) }
  }
  return (
    <>
      <PageHeader title="Microsoft Entra SSO" subtitle="Sign in with your Microsoft 365 / Entra ID account" icon={<KeyRound className="size-5" />}
        actions={<Button variant="primary" loading={busy} onClick={save} icon={<Save className="size-4" />}>Save</Button>} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Configuration">
          <div className="space-y-5">
            <Toggle checked={s.enabled} onChange={(enabled) => up({ enabled })} label="Enable Entra SSO" description="Shows 'Sign in with Microsoft' on the login screen. Local accounts keep working." />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Tenant ID (Directory ID)"><Input value={s.tenant_id} onChange={(e) => up({ tenant_id: e.target.value.trim() })} placeholder="00000000-0000-0000-0000-000000000000" /></Field>
              <Field label="Client ID (Application ID)"><Input value={s.client_id} onChange={(e) => up({ client_id: e.target.value.trim() })} /></Field>
              <Field label="Client secret" hint="Stored encrypted"><Input type="password" value={s.client_secret} onChange={(e) => up({ client_secret: e.target.value })} /></Field>
              <Field label="Button text"><Input value={s.button_label} onChange={(e) => up({ button_label: e.target.value })} /></Field>
              <Field label="Admin group (Object ID)" hint="Members become admins"><Input value={s.admin_group_id} onChange={(e) => up({ admin_group_id: e.target.value.trim() })} /></Field>
              <Field label="Allowed group (Object ID)" hint="Empty = everyone in the tenant"><Input value={s.allowed_group_id} onChange={(e) => up({ allowed_group_id: e.target.value.trim() })} /></Field>
              <Field label="Default role"><Select value={s.default_role} onChange={(default_role) => up({ default_role })} options={[{ value: 'viewer', label: 'Viewer' }, { value: 'admin', label: 'Admin' }]} /></Field>
            </div>
            <Toggle checked={s.auto_provision} onChange={(auto_provision) => up({ auto_provision })} label="Auto-provision users" description="Creates an account on first sign-in" />
          </div>
        </Card>
        <Card title="App registration in Entra">
          <ol className="list-decimal space-y-3 pl-4 text-sm text-muted">
            <li>In the <span className="text-[var(--text)]">Entra admin center</span>, go to App registrations → New registration.</li>
            <li>Choose platform <span className="text-[var(--text)]">Web</span> and enter this redirect URI:
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--panel-2)] px-2.5 py-2 font-mono text-xs text-[var(--text)]">
                <span className="truncate">{redirect}</span>
                <button onClick={() => { navigator.clipboard.writeText(redirect); toast('ok', 'Copied') }} className="cursor-pointer"><Copy className="size-3.5" /></button>
              </div>
            </li>
            <li>Under Certificates & secrets, create a client secret.</li>
            <li>If you use groups, add the <span className="text-[var(--text)]">groups</span> claim (Security groups) under Token configuration.</li>
            <li>URI not working behind a reverse proxy? Set the base URL under Settings.</li>
          </ol>
        </Card>
      </div>
    </>
  )
}
