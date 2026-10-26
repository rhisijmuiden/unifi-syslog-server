import type { ReactNode } from 'react'
import { ArrowRight, Router as RouterIcon, Wifi, Server, Cctv, ShieldCheck, Settings2 } from 'lucide-react'
import { t } from '../i18n'

function Box({ icon, title, lines, accent }: { icon: ReactNode; title: string; lines: string[]; accent: string }) {
  return (
    <div className="panel-2 min-w-0 flex-1 rounded-xl p-3 ring-1 ring-[var(--border)]">
      <div className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4" style={{ color: accent }}>{icon}<span className="text-[var(--text)]">{title}</span></div>
      <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  )
}

/** Which UniFi setting sends what, and where it ends up. */
export function Flow({ server }: { server: string }) {
  const arrow = <ArrowRight className="mx-auto size-5 shrink-0 rotate-90 text-muted lg:rotate-0" />
  return (
    <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
      <div className="flex flex-1 flex-col gap-3">
        <Box icon={<RouterIcon />} accent="#ef4444" title={t('Gateway and devices')} lines={[t('firewall, IPS, DHCP, DNS, VPN'), t('access points and switches')]} />
        <Box icon={<Cctv />} accent="#14b8a6" title={t('Console apps')} lines={[t('clients, admins, devices'), 'Protect, Access']} />
      </div>
      {arrow}
      <div className="flex flex-1 flex-col gap-3">
        <Box icon={<ShieldCheck />} accent="#6366f1" title="CyberSecure › Traffic Logging" lines={['Activity Logging (Syslog) = SIEM Server', 'Contents + Debug Logs']} />
        <Box icon={<Settings2 />} accent="#06b6d4" title="Control Plane › Integrations" lines={['Activity Logging (Syslog) = SIEM Server', t('CEF format')]} />
      </div>
      {arrow}
      <div className="flex-1">
        <div className="rounded-xl bg-gradient-to-br from-indigo-500/15 to-cyan-500/15 p-4 ring-1 ring-indigo-500/30">
          <div className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4"><Server className="text-indigo-400" />{t('This server')}</div>
          <div className="mt-1 font-mono text-xs">{server} : 514 UDP</div>
          <div className="mt-2 flex items-center gap-1 text-[11px] text-muted"><Wifi className="size-3" />{t('Parsed, enriched and searchable')}</div>
        </div>
      </div>
    </div>
  )
}
