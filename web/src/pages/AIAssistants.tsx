import { useState, type ReactNode } from 'react'
import { Bot, KeyRound, Plus, Download, Terminal, Code2, Monitor, Plug, Sparkles, Wrench, ShieldCheck, Lock } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api, can } from '../api'
import { useAuth } from '../App'
import { Badge, Button, Card, CopyBox, Field, Modal, PageHeader, Select, Spinner, Toggle, cx, useAsync, useToast } from '../components/ui'
import { t } from '../i18n'

interface Tool { name: string; title: string; description: string; admin: boolean }
interface Info {
  settings: { enabled: boolean }
  base_url: string
  endpoint: string
  self_signed: boolean
  pin: string
  version: string
  repo: string
  tools: Tool[]
}

type ClientKey = 'desktop' | 'code' | 'vscode' | 'other'
type OS = 'windows' | 'macos' | 'linux'

function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-indigo-500/15 text-xs font-semibold text-indigo-400">{n}</span>
      <div className="min-w-0 flex-1 space-y-2"><div className="text-sm font-medium">{title}</div>{children}</div>
    </li>
  )
}

const bridgeFiles: Record<OS, { label: string; files: [string, string][]; path: string }> = {
  windows: { label: 'Windows', files: [['x64', 'windows_amd64.exe'], ['ARM64', 'windows_arm64.exe']], path: 'C:\\Tools\\unify-syslog-mcp.exe' },
  macos: { label: 'macOS', files: [['Apple silicon', 'darwin_arm64'], ['Intel', 'darwin_amd64']], path: '/usr/local/bin/unify-syslog-mcp' },
  linux: { label: 'Linux', files: [['x64', 'linux_amd64'], ['ARM64', 'linux_arm64']], path: '/usr/local/bin/unify-syslog-mcp' },
}

const toolText = (): Record<string, string> => ({
  search_logs: t('Search log messages with the query language'),
  count_logs: t('Count messages over time, optionally per field'),
  top_values: t('Most frequent values of a field, such as blocked IP addresses'),
  search_everything: t('Search devices, clients, sites, saved searches and logs at once'),
  get_overview: t('The overview dashboard for a time range'),
  list_sites: t('Sites with devices and message counts'),
  list_devices: t('Device inventory with status and firmware'),
  list_clients: t('Known clients with name, MAC and IP address'),
  get_firmware_status: t('Firmware per model and outdated devices'),
  list_categories: t('Categories with message counts'),
  list_saved_searches: t('Your own and shared saved searches'),
  get_probe_status: t('Status of the remote probes'),
  query_language: t('How to write queries, with every field'),
  server_info: t('Version and storage, and the role of the token'),
  list_alert_rules: t('Alert rules and when they last fired'),
  get_system_status: t('Health of the server, ingest, disks and ClickHouse'),
})

export default function AIAssistants() {
  const { user } = useAuth()
  const toast = useToast()
  const info = useAsync(() => api.get<Info>('/mcp'))
  const [secret, setSecret] = useState<string>()
  const [create, setCreate] = useState<{ days: string }>()
  const [busy, setBusy] = useState(false)
  const [client, setClient] = useState<ClientKey>('desktop')
  const [os, setOS] = useState<OS>(() => /Mac/.test(navigator.platform) ? 'macos' : /Linux/.test(navigator.platform) ? 'linux' : 'windows')

  const d = info.data
  if (!d) return <div className="grid place-items-center py-24"><Spinner /></div>

  const toggle = async (enabled: boolean) => {
    try { await api.put('/settings/mcp', { enabled }); info.reload(); toast('ok', enabled ? t('MCP server turned on') : t('MCP server turned off')) } catch (e) { toast('err', (e as Error).message) }
  }
  const newToken = async () => {
    setBusy(true)
    try {
      const r = await api.post<{ secret: string }>('/tokens', { name: t('AI assistant (MCP)'), read_only: true, days: Number(create!.days) })
      setSecret(r.secret); setCreate(undefined)
    } catch (e) { toast('err', (e as Error).message) } finally { setBusy(false) }
  }

  const token = secret ?? 'uss_…'
  const pinArgs = d.self_signed && d.pin ? ['--pin', d.pin] : []
  const dev = d.version.includes('dev')
  const download = (suffix: string) => dev
    ? `https://github.com/${d.repo}/releases/latest/download/unify-syslog-mcp_${suffix}`
    : `https://github.com/${d.repo}/releases/download/v${d.version}/unify-syslog-mcp_${suffix}`
  const bf = bridgeFiles[os]
  const desktopConfig = JSON.stringify({
    mcpServers: { 'unifi-syslog': { command: bf.path, args: ['--url', d.base_url, ...pinArgs], env: { USS_MCP_TOKEN: token } } },
  }, null, 2)
  const configPath = os === 'windows' ? '%APPDATA%\\Claude\\claude_desktop_config.json' : os === 'macos' ? '~/Library/Application Support/Claude/claude_desktop_config.json' : '~/.config/Claude/claude_desktop_config.json'
  const httpCmd = `claude mcp add --transport http unifi-syslog ${d.endpoint} --header "Authorization: Bearer ${token}"`
  const bridgeCmd = `claude mcp add --env USS_MCP_TOKEN=${token} unifi-syslog -- unify-syslog-mcp --url ${d.base_url}${pinArgs.length ? ' --pin ' + d.pin : ''}`
  const vscode = JSON.stringify({ servers: { 'unifi-syslog': { type: 'http', url: d.endpoint, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)

  const clients: { key: ClientKey; label: string; icon: ReactNode }[] = [
    { key: 'desktop', label: 'Claude Desktop', icon: <Monitor className="size-4" /> },
    { key: 'code', label: 'Claude Code', icon: <Terminal className="size-4" /> },
    { key: 'vscode', label: 'VS Code · Copilot', icon: <Code2 className="size-4" /> },
    { key: 'other', label: t('Other clients'), icon: <Plug className="size-4" /> },
  ]
  const examples = [
    t('Which IP addresses were blocked most by the firewall in the last 24 hours, and from which countries?'),
    t('Did any access point go silent this week?'),
    t('Show the IPS alerts of the last 7 days and explain the three most serious ones.'),
    t('When did the DHCP errors at site Amsterdam start, and is it getting worse?'),
    t('Is the syslog server healthy? Are messages being dropped?'),
  ]
  const certNote = d.self_signed && (
    <p className="text-xs text-muted">{t('This server uses a self-signed certificate. The bridge trusts it through the key pin (--pin), so the connection is still encrypted and verified. Clients that connect directly over HTTPS need a trusted certificate (tls_cert in config.yaml), or use http:// on a trusted network.')}</p>
  )

  return (
    <>
      <PageHeader title={t('AI assistants (MCP)')} subtitle={t('Let Claude and other AI assistants search your logs with the Model Context Protocol')} icon={<Bot className="size-5" />} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2" title={t('MCP server')} subtitle={t('An AI assistant asks questions in plain language; the MCP server answers them from the logs, with the role and sites of your API token.')}
          actions={d.settings.enabled ? <Badge className="bg-emerald-500/15 text-emerald-500 ring-emerald-500/30">{t('On')}</Badge> : <Badge className="bg-red-500/15 text-red-500 ring-red-500/30">{t('Off')}</Badge>}>
          <div className="space-y-4">
            <Field label={t('Endpoint (Streamable HTTP)')}><CopyBox text={d.endpoint} /></Field>
            {can.admin(user) && <Toggle checked={d.settings.enabled} onChange={toggle} label={t('Allow AI assistants')} description={t('Serve /mcp. Every request needs an API token; the tools only read and never change anything.')} />}
            {!d.settings.enabled && !can.admin(user) && <p className="text-sm text-amber-500">{t('An administrator has turned the MCP server off.')}</p>}
          </div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4 text-emerald-500" />{t('Safe by design')}</span>}>
          <ul className="space-y-2 text-sm text-muted">
            <li className="flex gap-2"><Lock className="mt-0.5 size-4 shrink-0 text-indigo-400" />{t('Only read-only tools: an assistant can never change settings or delete data.')}</li>
            <li className="flex gap-2"><KeyRound className="mt-0.5 size-4 shrink-0 text-indigo-400" />{t('The token decides what the assistant sees: a viewer token only sees its own sites.')}</li>
            <li className="flex gap-2"><Wrench className="mt-0.5 size-4 shrink-0 text-indigo-400" />{t('Every search is in the audit log, marked with the token name.')}</li>
          </ul>
        </Card>

        <Card className="xl:col-span-2" title={t('Connect an assistant')}>
          <ol className="space-y-6">
            <Step n={1} title={t('Create an API token')}>
              {secret ? (
                <div className="space-y-2">
                  <p className="text-xs text-amber-500">{t('Copy the token now. It is shown only once. It is filled in below.')}</p>
                  <CopyBox text={secret} />
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreate({ days: '365' })}>{t('Create a read-only token')}</Button>
                  <span className="text-xs text-muted">{t('or use an existing one from')} <Link to="/account" className="text-indigo-400 hover:underline">{t('My account')}</Link></span>
                </div>
              )}
            </Step>
            <Step n={2} title={t('Choose your assistant')}>
              <div className="flex flex-wrap gap-1.5">
                {clients.map((x) => (
                  <button key={x.key} onClick={() => setClient(x.key)}
                    className={cx('flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 transition', client === x.key ? 'bg-indigo-500/15 text-indigo-400 ring-indigo-500/40' : 'text-muted ring-[var(--border)] hover:text-[var(--text)]')}>
                    {x.icon}{x.label}
                  </button>
                ))}
              </div>
            </Step>

            {client === 'desktop' && <>
              <Step n={3} title={t('Download the MCP bridge for your computer')}>
                <p className="text-xs text-muted">{t('Claude Desktop starts local MCP servers. The small bridge program passes its questions on to this server.')}</p>
                <div className="flex flex-wrap items-center gap-3">
                  <Select value={os} onChange={(v) => setOS(v as OS)} options={(Object.keys(bridgeFiles) as OS[]).map((k) => ({ value: k, label: bridgeFiles[k].label }))} className="w-40" />
                  {bf.files.map(([label, suffix]) => (
                    <a key={suffix} href={download(suffix)} className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm ring-1 ring-[var(--border)] transition hover:bg-[var(--panel-2)] hover:ring-indigo-400/60">
                      <Download className="size-4 text-indigo-400" />{label}
                    </a>
                  ))}
                </div>
                <p className="text-xs text-muted">
                  {os === 'windows' ? t('Save it as {path}.', { path: bf.path })
                    : os === 'macos' ? t('Save it as {path}, then run chmod +x and xattr -d com.apple.quarantine on it.', { path: bf.path })
                    : t('Save it as {path} and run chmod +x on it.', { path: bf.path })}
                </p>
              </Step>
              <Step n={4} title={t('Add the server to Claude Desktop')}>
                <p className="text-xs text-muted">{t('Settings → Developer → Edit Config opens {file}. Add this and restart Claude Desktop:', { file: configPath })}</p>
                <CopyBox multiline text={desktopConfig} />
                {certNote}
              </Step>
            </>}

            {client === 'code' && <>
              <Step n={3} title={t('Add the server')}>
                {d.self_signed ? <>
                  <p className="text-xs text-muted">{t('With the bridge (works with the self-signed certificate; download it under Claude Desktop):')}</p>
                  <CopyBox multiline text={bridgeCmd} />
                  <p className="text-xs text-muted">{t('Or directly, when the server has a trusted certificate:')}</p>
                </> : null}
                <CopyBox multiline text={httpCmd} />
                {certNote}
              </Step>
              <Step n={4} title={t('Check the connection')}><CopyBox text="claude mcp list" /></Step>
            </>}

            {client === 'vscode' && <>
              <Step n={3} title={t('Add the server to .vscode/mcp.json')}>
                <CopyBox multiline text={vscode} />
                <p className="text-xs text-muted">{t('Then open Copilot Chat in agent mode and turn on the unifi-syslog tools.')}</p>
                {certNote}
              </Step>
            </>}

            {client === 'other' && <>
              <Step n={3} title={t('Remote MCP server (Streamable HTTP)')}>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                  <dt className="text-muted">URL</dt><dd className="break-all font-mono">{d.endpoint}</dd>
                  <dt className="text-muted">{t('Header')}</dt><dd className="break-all font-mono">Authorization: Bearer {token}</dd>
                </dl>
                <p className="text-xs text-muted">{t('Works with Cursor, Windsurf, LibreChat, n8n and other clients that support remote MCP servers with a header.')}</p>
              </Step>
              <Step n={4} title={t('Clients that only support stdio')}>
                <CopyBox multiline text={`USS_MCP_TOKEN=${token} unify-syslog-mcp --url ${d.base_url}${pinArgs.length ? ' --pin ' + d.pin : ''}`} />
                <p className="text-xs text-muted">{t('Claude.ai in the browser and the mobile apps connect from the internet with OAuth; that is not supported yet. Use Claude Desktop or Claude Code.')}</p>
              </Step>
            </>}
          </ol>
        </Card>

        <Card title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-amber-500" />{t('Try asking')}</span>}>
          <ul className="space-y-2.5">
            {examples.map((q) => <li key={q} className="rounded-xl bg-[var(--panel-2)] px-3 py-2 text-sm">“{q}”</li>)}
          </ul>
        </Card>

        <Card className="xl:col-span-3" title={t('Tools')} subtitle={t('What an assistant can do with your token')} pad={false}>
          <div className="grid gap-px overflow-hidden rounded-b-2xl bg-[var(--border)] sm:grid-cols-2 xl:grid-cols-3">
            {d.tools.map((x) => (
              <div key={x.name} className="space-y-1 bg-[var(--panel)] px-5 py-4">
                <div className="flex items-center gap-2"><span className="font-mono text-sm font-medium">{x.name}</span>{x.admin && <Badge>{t('Administrators')}</Badge>}</div>
                <p className="text-xs text-muted">{toolText()[x.name] ?? x.description}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Modal open={!!create} onClose={() => setCreate(undefined)} title={t('Create a read-only token')}
        footer={<><Button onClick={() => setCreate(undefined)}>{t('Cancel')}</Button><Button variant="primary" loading={busy} onClick={newToken}>{t('Create')}</Button></>}>
        {create && (
          <div className="space-y-4">
            <p className="text-sm text-muted">{t('The token gets your role and sites, and can only read. Revoke it any time under My account.')}</p>
            <Field label={t('Expires after')}><Select value={create.days} onChange={(days) => setCreate({ days })} options={[
              { value: '30', label: t('30 days') }, { value: '90', label: t('90 days') }, { value: '365', label: t('1 year') }, { value: '0', label: t('Never') },
            ]} /></Field>
          </div>
        )}
      </Modal>
    </>
  )
}
