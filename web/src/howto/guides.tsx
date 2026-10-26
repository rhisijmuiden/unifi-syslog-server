import type { ReactNode } from 'react'
import { Rocket, ShieldX, Siren, Network, Wifi, Globe, Lock, UserCog, Cctv, LifeBuoy } from 'lucide-react'
import { t } from '../i18n'
import Mockup from './Mockup'
import { Flow } from './Flow'
import { integrations, Note, Path, rich, Sample, Section, serverAddress, settingsMenu, Step, Steps, trafficLogging, UI, Verify } from './parts'

export interface Guide {
  id: string
  icon: ReactNode
  /** Accent for the card icon. */
  color: string
  title: () => string
  summary: () => string
  /** Log categories this guide produces, shown as badges. */
  categories: string[]
  body: () => ReactNode
}

const versionNote = () => (
  <Note title={t('Which UniFi version?')}>
    <p>{t('Menu paths are for UniFi Network 9.3 and newer on UniFi OS 4 consoles (Cloud Gateway, Dream Machine, Cloud Key, self-hosted). Older versions keep the same options elsewhere:')}</p>
    <ul className="list-disc space-y-0.5 pl-4">
      <li>{rich(t('Network 9.0–9.2: {a} and {b}.'), { a: <Path p="Settings > Security > Traffic Logging" />, b: <Path p="Settings > Security > Firewall Rules" /> })}</li>
      <li>{rich(t('Network 8 and older: {a}, and per rule {b}.'), { a: <Path p="Settings > System > Integrations" />, b: <Path p="Settings > Security > Traffic & Firewall Rules" /> })}</li>
    </ul>
  </Note>
)

export const guides: Guide[] = [
  {
    id: 'start',
    icon: <Rocket />,
    color: '#6366f1',
    title: () => t('Send UniFi logs to this server'),
    summary: () => t('The two places in UniFi where you point syslog at this server. Start here.'),
    categories: [],
    body: () => (
      <>
        <Section title={t('How the logs travel')}>
          <p className="text-sm text-muted">{t('UniFi has two separate syslog senders. Both can point at the same address and port; this server recognises every format on its own.')}</p>
          <Flow server={serverAddress()} />
        </Section>
        <Section title={t('1. Traffic Logging: gateway, firewall, IPS, DHCP')}>
          <Steps>
            <Step n={1}>{rich(t('In the UniFi Network app open {path}.'), { path: <Path p="Settings > CyberSecure > Traffic Logging" /> })}</Step>
            <Step n={2}>{rich(t('Set {opt} to {val}.'), { opt: <UI>Activity Logging (Syslog)</UI>, val: <UI>SIEM Server</UI> })}</Step>
            <Step n={3}>{rich(t('Tick every option under {opt}. Each guide here says which one it needs.'), { opt: <UI>Contents</UI> })}</Step>
            <Step n={4}>{rich(t('Enter {addr} as {opt}, port {port}, and click {apply}.'), { addr: <b className="font-mono">{serverAddress()}</b>, opt: <UI>Server Address</UI>, port: <b className="font-mono">514</b>, apply: <UI>Apply Changes</UI> })}</Step>
          </Steps>
          <Mockup spec={trafficLogging({ menu: 1, mode: 2, contents: 3, server: 4 })} caption={t('Traffic Logging')} />
        </Section>
        <Section title={t('2. Activity Logging: clients, devices, admins (CEF)')}>
          <Steps>
            <Step n={1}>{rich(t('Open {path}.'), { path: <Path p="Settings > Control Plane > Integrations" /> })}</Step>
            <Step n={2}>{rich(t('Set {opt} to {val} as well, and tick the categories you want.'), { opt: <UI>Activity Logging (Syslog)</UI>, val: <UI>SIEM Server</UI> })}</Step>
            <Step n={3}>{rich(t('Use the same address {addr} and port {port}.'), { addr: <b className="font-mono">{serverAddress()}</b>, port: <b className="font-mono">514</b> })}</Step>
          </Steps>
          <Mockup spec={integrations({ menu: 1, mode: 2, server: 3 })} caption={t('Activity Logging (CEF)')} />
          <Note warn title={t('Avoid duplicates')}>
            <p>{t('Some categories (Security Detections, VPN, Critical, Updates) exist on both pages. Tick them on one page only, otherwise every event is stored twice.')}</p>
          </Note>
        </Section>
        <Section title={t('Check that it arrives')}>
          <p className="text-sm text-muted">{rich(t('Within a minute the gateway shows up under {devices}. Sites behind NAT arrive from their WAN address; give that address a name under {sites}.'), { devices: <b>{t('Devices')}</b>, sites: <b>{t('Sites')}</b> })}</p>
          <Verify query="*" dashboard="/devices" />
        </Section>
        {versionNote()}
      </>
    ),
  },
  {
    id: 'firewall',
    icon: <ShieldX />,
    color: '#ef4444',
    title: () => t('Firewall: blocked IP addresses'),
    summary: () => t('Log blocked and allowed traffic per firewall rule, so blocked IPs, ports and countries show up.'),
    categories: ['firewall'],
    body: () => (
      <>
        <Note title={t('Why you see nothing yet')}>
          <p>{t('UniFi does not log firewall hits by default. You switch logging on in two places: for the built-in default block rules, and on each of your own rules.')}</p>
        </Note>
        <Section title={t('1. Log the built-in block rules')}>
          <p className="text-sm text-muted">{t('The default policies block everything from the internet that you did not allow. Logging them gives you the scanners and attackers knocking on your WAN.')}</p>
          <Steps>
            <Step n={1}>{rich(t('Open {path}.'), { path: <Path p="Settings > CyberSecure > Traffic Logging" /> })}</Step>
            <Step n={2}>{rich(t('Under {opt}, tick {val}.'), { opt: <UI>Contents</UI>, val: <UI>Firewall Default Policy</UI> })}</Step>
            <Step n={3}>{rich(t('Set {opt} to {val} (or {all} if you also want allowed connections, which is a lot more data).'), { opt: <UI>Flow Logging</UI>, val: <UI>Blocked Only</UI>, all: <UI>All Traffic</UI> })}</Step>
          </Steps>
          <Mockup spec={trafficLogging({ marks: { 'Firewall Default Policy': 2 }, flow: 3 })} />
        </Section>
        <Section title={t('2. Log your own firewall rules')}>
          <Steps>
            <Step n={1}>{rich(t('Open {path}.'), { path: <Path p="Settings > Policy Engine > Policy Table" /> })}</Step>
            <Step n={2}>{t('Click the name of a policy you want to see, for example a block rule between VLANs.')}</Step>
            <Step n={3}>{rich(t('Tick {opt} (under Advanced) and click {apply}. Repeat for every rule you want to follow.'), { opt: <UI>Syslog Logging</UI>, apply: <UI>Apply Changes</UI> })}</Step>
          </Steps>
          <div className="grid gap-6">
            <Mockup spec={{
              path: ['Settings', 'Policy Engine', 'Policy Table'],
              menu: { items: settingsMenu, active: 'Policy Engine', mark: 1 },
              rows: [{ kind: 'table', label: 'Firewall Policies', columns: ['Name', 'Action', 'Source', 'Destination'], rows: [
                { cells: ['Block IoT to LAN', 'Block', 'IoT', 'Internal'], mark: 2 },
                { cells: ['Allow DNS', 'Allow', 'Internal', 'Gateway'] },
                { cells: ['Block Guest to LAN', 'Block', 'Hotspot', 'Internal'] },
                { cells: ['Block All Traffic', 'Block', 'External', 'Internal'] },
              ] }],
            }} />
            <Mockup spec={{
              path: ['Settings', 'Policy Engine', 'Block IoT to LAN'],
              panel: 'Edit Policy',
              rows: [
                { kind: 'input', label: 'Name', value: 'Block IoT to LAN' },
                { kind: 'segmented', label: 'Action', options: ['Allow', 'Block', 'Reject'], value: 'Block' },
                { kind: 'heading', label: 'Advanced' },
                { kind: 'checks', label: 'Logging', options: [{ label: 'Syslog Logging', on: true, mark: 3 }] },
                { kind: 'button', label: 'Apply Changes' },
              ],
            }} />
          </div>
          <Note>
            <p>{t('Give rules a clear name. UniFi puts it in the log line, and this server shows it as the rule name in Logs and on the Firewall dashboard.')}</p>
            <p>{t('Port forwards have the same Syslog Logging option, which shows who connects to your forwarded services.')}</p>
          </Note>
        </Section>
        <Section title={t('What it looks like')}>
          <Sample lines={[
            'kernel: [WAN_LOCAL-D-2147483647] IN=eth8 OUT= SRC=185.220.101.4 DST=84.1.2.3 PROTO=TCP SPT=48211 DPT=23',
            'kernel: [CUSTOM1_LAN-B-30000] DESCR="Block IoT to LAN" IN=br20 OUT=br0 SRC=192.168.20.5 DST=192.168.1.10 PROTO=UDP DPT=5353',
          ]} />
          <Verify query="category:firewall action:block" dashboard="/dashboards/firewall" />
        </Section>
        {versionNote()}
      </>
    ),
  },
  {
    id: 'ips',
    icon: <Siren />,
    color: '#f97316',
    title: () => t('Threats (IPS / IDS)'),
    summary: () => t('Intrusion detection alerts with signature, severity and attacker country.'),
    categories: ['ips'],
    body: () => (
      <>
        <Section title={t('Turn on detection')}>
          <Steps>
            <Step n={1}>{rich(t('Open {path}.'), { path: <Path p="Settings > CyberSecure > Protection" /> })}</Step>
            <Step n={2}>{rich(t('Switch on {opt} and choose {a} (only alerts) or {b} (alerts and blocks).'), { opt: <UI>Intrusion Prevention</UI>, a: <UI>Notify</UI>, b: <UI>Notify and Block</UI> })}</Step>
            <Step n={3}>{t('Select the networks it should watch and the detection categories.')}</Step>
          </Steps>
          <Mockup spec={{
            path: ['Settings', 'CyberSecure', 'Protection'],
            menu: { items: settingsMenu, active: 'CyberSecure' },
            tabs: { items: ['Protection', 'Encrypted DNS', 'Ad Blocking', 'Content Filtering', 'Traffic Logging'], active: 'Protection', mark: 1 },
            rows: [
              { kind: 'toggle', label: 'Intrusion Prevention', on: true, mark: 2 },
              { kind: 'segmented', label: 'Mode', options: ['Notify', 'Notify and Block'], value: 'Notify and Block', mark: 2 },
              { kind: 'checks', label: 'Networks', mark: 3, options: [{ label: 'Default', on: true }, { label: 'IoT', on: true }, { label: 'Guest', on: true }, { label: 'Servers', on: true }] },
              { kind: 'select', label: 'Detection Mode', value: 'Recommended' },
            ],
          }} />
        </Section>
        <Section title={t('Send the alerts')}>
          <Steps>
            <Step n={4}>{rich(t('In {path}, tick {val} under {opt}.'), { path: <Path p="Settings > CyberSecure > Traffic Logging" />, val: <UI>Security Detections</UI>, opt: <UI>Contents</UI> })}</Step>
          </Steps>
          <Mockup spec={trafficLogging({ marks: { 'Security Detections': 4 } })} />
          <Sample lines={['suricata[1234]: [1:2402000:6890] ET DROP Dshield Block Listed Source [**] [Classification: Misc Attack] [Priority: 2] {TCP} 45.148.10.12:41234 -> 84.1.2.3:22']} />
          <Verify query="category:ips" dashboard="/dashboards/ips" />
        </Section>
      </>
    ),
  },
  {
    id: 'dhcp',
    icon: <Network />,
    color: '#06b6d4',
    title: () => t('DHCP leases'),
    summary: () => t('Which device got which IP address, with host names. Needs Debug Logs.'),
    categories: ['dhcp'],
    body: () => (
      <>
        <Note warn title={t('Why DHCP logs do not arrive')}>
          <p>{rich(t('The UniFi gateway hands out leases with dnsmasq, but only sends those messages over syslog when {opt} is ticked. Without it there is no DHCP data, whatever else you enable.'), { opt: <UI>Debug Logs</UI> })}</p>
        </Note>
        <Section title={t('Turn on Debug Logs')}>
          <Steps>
            <Step n={1}>{rich(t('Open {path}.'), { path: <Path p="Settings > CyberSecure > Traffic Logging" /> })}</Step>
            <Step n={2}>{rich(t('Make sure {opt} is set to {val} and points at this server.'), { opt: <UI>Activity Logging (Syslog)</UI>, val: <UI>SIEM Server</UI> })}</Step>
            <Step n={3}>{rich(t('Tick {opt} and click {apply}.'), { opt: <UI>Debug Logs</UI>, apply: <UI>Apply Changes</UI> })}</Step>
          </Steps>
          <Mockup spec={trafficLogging({ mode: 2, debug: 3, apply: 3 })} />
          <Note>
            <p>{t('Debug Logs also sends other system messages (DNS, VPN daemons, SSH logins on the gateway), so expect more data. Keep it in check with a shorter retention for the DHCP and system categories under Settings.')}</p>
          </Note>
        </Section>
        <Section title={t('Switches with DHCP snooping')}>
          <p className="text-sm text-muted">{rich(t('UniFi switches with {opt} switched on report the leases they see pass by. This server reads those too, so leases of a DHCP server elsewhere on the network still show up.'), { opt: <UI>DHCP Snooping</UI> })}</p>
        </Section>
        <Section title={t('Another DHCP server?')}>
          <p className="text-sm text-muted">{t('If a Windows server, Pi-hole or other device hands out addresses, UniFi has nothing to log. Send the syslog of that server here directly; dnsmasq, ISC dhcpd and Kea messages are recognised.')}</p>
        </Section>
        <Section title={t('What it looks like')}>
          <Sample lines={[
            'dnsmasq-dhcp[2345]: DHCPACK(br0) 192.168.1.20 aa:bb:cc:dd:ee:ff Alex-iPhone',
            'dnsmasq-dhcp[2345]: 3891312347 DHCPREQUEST(br20) 192.168.20.31 11:22:33:44:55:66',
            'dhcp_relay#dhcpsnpd[34]: ACK received: ifname Ethernet46, ..., chaddr aa:7f:aa:f3:bc:29, yiaddr 172.16.4.67.',
          ]} />
          <p className="text-sm text-muted">{t('Host names from DHCP are also used to name clients when no UniFi controller is connected.')}</p>
          <Verify query="category:dhcp" dashboard="/dashboards/dhcp" />
        </Section>
      </>
    ),
  },
  {
    id: 'wifi',
    icon: <Wifi />,
    color: '#22c55e',
    title: () => t('Wi-Fi clients'),
    summary: () => t('Connects, disconnects, roaming and failed logins from the access points.'),
    categories: ['wifi', 'client'],
    body: () => (
      <>
        <Section title={t('From the access points')}>
          <p className="text-sm text-muted">{t('Once Traffic Logging points at this server, the console also configures the access points to send their syslog here. Their association, roaming and authentication messages (hostapd, stahtd) are recognised automatically.')}</p>
          <Steps>
            <Step n={1}>{rich(t('Set up {path} as in the first guide.'), { path: <Path p="Settings > CyberSecure > Traffic Logging" /> })}</Step>
            <Step n={2}>{rich(t('Tick {opt} for detailed connection problems (wrong password, no DHCP answer, no DNS answer).'), { opt: <UI>Debug Logs</UI> })}</Step>
          </Steps>
        </Section>
        <Section title={t('Client events with names (CEF)')}>
          <Steps>
            <Step n={3}>{rich(t('In {path}, tick {val}. These events carry the client name, SSID and access point name.'), { path: <Path p="Settings > Control Plane > Integrations" />, val: <UI>Clients</UI> })}</Step>
          </Steps>
          <Mockup spec={integrations({ marks: { Clients: 3 } })} />
          <Sample lines={[
            'hostapd: ath0: STA 11:22:33:44:55:66 IEEE 802.11: associated',
            'CEF:0|Ubiquiti|UniFi Network|9.3.43|400|WiFi Client Connected|1|UNIFIclientAlias=Alex iPhone UNIFIwifiName=Home ...',
          ]} />
          <Verify query="category:wifi" dashboard="/dashboards/wifi" />
        </Section>
      </>
    ),
  },
  {
    id: 'dns',
    icon: <Globe />,
    color: '#a855f7',
    title: () => t('DNS, ad blocking and content filtering'),
    summary: () => t('Blocked domains from Ad Blocking and Content Filtering, per client.'),
    categories: ['dns'],
    body: () => (
      <>
        <Note title={t('What to expect')}>
          <p>{t('UniFi does not log every DNS query. What you do get are the domains blocked by Ad Blocking and Content Filtering, with the client that asked for them.')}</p>
        </Note>
        <Section title={t('Turn it on')}>
          <Steps>
            <Step n={1}>{rich(t('Switch on {a} and/or {b} in {path} for the networks you want.'), { a: <UI>Ad Blocking</UI>, b: <UI>Content Filtering</UI>, path: <Path p="Settings > CyberSecure" /> })}</Step>
            <Step n={2}>{rich(t('If no block messages arrive, also tick {opt} in {path}; they come from the DNS service on the gateway.'), { path: <Path p="Settings > CyberSecure > Traffic Logging" />, opt: <UI>Debug Logs</UI> })}</Step>
          </Steps>
          <Mockup spec={{
            path: ['Settings', 'CyberSecure', 'Ad Blocking'],
            menu: { items: settingsMenu, active: 'CyberSecure' },
            tabs: { items: ['Protection', 'Encrypted DNS', 'Ad Blocking', 'Content Filtering', 'Traffic Logging'], active: 'Ad Blocking', mark: 1 },
            rows: [
              { kind: 'toggle', label: 'Ad Blocking', on: true, mark: 1 },
              { kind: 'checks', label: 'Networks', options: [{ label: 'Default', on: true }, { label: 'IoT', on: true }, { label: 'Guest', on: true }, { label: 'Servers', on: false }] },
            ],
          }} />
          <Sample lines={['coredns[123]: {"type":"dnsAdBlock","category":"ADVERTISEMENT","domain":"ads.example.com","ip":"192.168.1.20","mac":"aa:bb:cc:dd:ee:ff"}']} />
          <Verify query="category:dns action:block" />
        </Section>
      </>
    ),
  },
  {
    id: 'vpn',
    icon: <Lock />,
    color: '#0ea5e9',
    title: () => t('VPN'),
    summary: () => t('WireGuard, Teleport, OpenVPN and site-to-site tunnels going up and down, and who connected.'),
    categories: ['vpn'],
    body: () => (
      <>
        <Section title={t('Turn it on')}>
          <Steps>
            <Step n={1}>{rich(t('In {path}, tick {opt} under Contents.'), { path: <Path p="Settings > CyberSecure > Traffic Logging" />, opt: <UI>VPN</UI> })}</Step>
            <Step n={2}>{rich(t('Tick {opt} for the messages of the VPN daemons themselves (handshakes, IPsec negotiation).'), { opt: <UI>Debug Logs</UI> })}</Step>
            <Step n={3}>{rich(t('Optionally tick {opt} in {path} for client connect events with user names.'), { opt: <UI>VPN</UI>, path: <Path p="Settings > Control Plane > Integrations" /> })}</Step>
          </Steps>
          <Mockup spec={trafficLogging({ marks: { VPN: 1 }, debug: 2 })} />
          <Sample lines={['charon: 09[IKE] IKE_SA site-to-site[3] established between 84.1.2.3[84.1.2.3]...91.2.3.4[91.2.3.4]']} />
          <Verify query="category:vpn" dashboard="/dashboards/vpn" />
        </Section>
      </>
    ),
  },
  {
    id: 'system',
    icon: <UserCog />,
    color: '#64748b',
    title: () => t('Sign-ins, admin activity and devices'),
    summary: () => t('Admin logins and changes, SSH sign-ins, devices adopting, rebooting and updating, switch ports.'),
    categories: ['admin', 'auth', 'device', 'switch', 'system'],
    body: () => (
      <>
        <Section title={t('Admin activity and devices (CEF)')}>
          <Steps>
            <Step n={1}>{rich(t('Open {path}.'), { path: <Path p="Settings > Control Plane > Integrations" /> })}</Step>
            <Step n={2}>{rich(t('Tick {a}, {b} and {c} under UniFi Network, and {d}, {e} and {f} under UniFi OS.'), { a: <UI>Admin Activity</UI>, b: <UI>Devices</UI>, c: <UI>Triggers</UI>, d: <UI>System</UI>, e: <UI>Admins</UI>, f: <UI>Users</UI> })}</Step>
          </Steps>
          <Mockup spec={integrations({ marks: { 'Admin Activity': 2, Devices: 2, Triggers: 2, System: 2, Admins: 2, Users: 2 } })} />
        </Section>
        <Section title={t('SSH logins and switch ports')}>
          <p className="text-sm text-muted">{rich(t('SSH sign-ins on the gateway, switch port up/down and PoE messages come from the devices themselves. Tick {opt} in Traffic Logging to receive them.'), { opt: <UI>Debug Logs</UI> })}</p>
          <Sample lines={[
            'CEF:0|Ubiquiti|UniFi Network|9.3.43|544|Admin Accessed UniFi Network|2|UNIFIadmin=admin UNIFIsourceIp=192.168.1.10 ...',
            'sshd[4567]: Failed password for root from 45.148.10.12 port 52144 ssh2',
          ]} />
          <Verify query="category:admin OR category:auth" />
        </Section>
      </>
    ),
  },
  {
    id: 'protect',
    icon: <Cctv />,
    color: '#14b8a6',
    title: () => t('UniFi Protect and Access'),
    summary: () => t('Motion and smart detections, doorbell rings, camera status, door access granted or denied.'),
    categories: ['protect', 'access'],
    body: () => (
      <>
        <Section title={t('Send the events')}>
          <p className="text-sm text-muted">{t('Protect and Access run on the same UniFi OS console and send their events in CEF format through the console integration.')}</p>
          <Steps>
            <Step n={1}>{rich(t('On the console that runs Protect or Access, open {path}.'), { path: <Path p="Settings > Control Plane > Integrations" /> })}</Step>
            <Step n={2}>{rich(t('Set {opt} to {val} with this server as destination and tick the Protect and Access categories your console offers.'), { opt: <UI>Activity Logging (Syslog)</UI>, val: <UI>SIEM Server</UI> })}</Step>
            <Step n={3}>{t('In Protect, smart detections only produce events for cameras where they are switched on (person, vehicle, package, …).')}</Step>
          </Steps>
          <Note warn>
            <p>{t('Not every UniFi OS version offers Protect and Access here yet. If you do not see them, update the console and the Protect and Access apps first.')}</p>
          </Note>
          <Verify query="category:protect OR category:access" />
        </Section>
      </>
    ),
  },
  {
    id: 'troubleshooting',
    icon: <LifeBuoy />,
    color: '#eab308',
    title: () => t('Troubleshooting: no data arrives'),
    summary: () => t('A checklist for when a site, device or category stays empty.'),
    categories: [],
    body: () => (
      <>
        <Section title={t('Checklist')}>
          <Steps>
            <Step n={1}>{rich(t('Is the source blocked? Look under {page}: rejected senders are listed there with one-click allow.'), { page: <b>{t('Source allowlist')}</b> })}</Step>
            <Step n={2}>{t('Can UDP port 514 reach this server? Firewalls between sites, or a cloud host with a security group, often block it. A remote probe at the site avoids the problem.')}</Step>
            <Step n={3}>{rich(t('Does the server receive anything at all? {page} shows the messages per second it takes in.'), { page: <b>{t('System status')}</b> })}</Step>
            <Step n={4}>{t('Only one category missing? Check the guide for that category: firewall logging is per rule, DHCP needs Debug Logs, IPS needs Security Detections.')}</Step>
            <Step n={5}>{t('Wrong time on the log lines? UniFi sends local time without a zone; set the device time zone under Settings.')}</Step>
            <Step n={6}>{t('Everything twice? The same category is ticked both in Traffic Logging and in Control Plane Integrations.')}</Step>
          </Steps>
        </Section>
        <Section title={t('Test from the command line')}>
          <p className="text-sm text-muted">{t('From any Linux machine at the site, send a test line and search for it:')}</p>
          <Sample lines={[`logger -n ${serverAddress()} -P 514 -d "uss-test hello from $(hostname)"`]} />
          <Verify query='"uss-test"' />
        </Section>
      </>
    ),
  },
]
