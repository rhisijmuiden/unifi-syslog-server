# Roadmap

Last updated: 18 October 2026

This document describes where Unify Syslog Server is heading. Order and scope are a plan, not a promise; priorities may shift between releases.

Milestone numbers (1.1, 1.2, …) are planning labels. They are not the same as release version numbers; shipped milestones list the release that delivered them.

---

## Foundation (shipped in v0.1.0)

- Syslog receiver on UDP/TCP 514
- UniFi-specific parser: device name (`model,mac,version`), firewall rules (iptables tags), CEF from UniFi Network SIEM, Wi-Fi (hostapd/stahtd), DHCP/DNS (dnsmasq) and IPS (Suricata)
- Log storage in ClickHouse, configuration in SQLite
- Web interface on port 8080 with dashboard, log search and categories
- Sites mapped from IP ranges, and e-mail alerts on a search query with a threshold
- Microsoft Entra SSO, custom SMTP server, full and incremental backups to FTP, FTPS and SCP with restore
- Info button with version, update check and in-app update
- Install as a Proxmox LXC (Debian 13) or with the installer for a Debian 13 VM or physical server

---

## 1.1 Usability and alerting

Goal: move from "looking at logs" to "knowing in time that something is wrong".

| Item | Description | Status |
|---|---|---|
| Site overview | A card per site with status, devices and the last 24 hours of logs, blocks, IPS events and errors | Shipped in v0.2.0 |
| Device inventory | Persistent inventory keyed by MAC address (works behind NAT), custom names and notes, firmware per model, and e-mail when a device goes silent or comes back | Shipped in v0.2.0 |
| Notification channels | Next to e-mail: **Microsoft Teams** (Workflows webhook into a channel), **Telegram** (bot to a chat or group), **Slack** (incoming webhook or app into a channel), **SMS via MessageBird** (Bird) and a generic webhook. Easy to extend later, e.g. Pushover | Planned |
| Channels per rule | Choose per alert rule which channels and recipients are used, e.g. Teams for everything and SMS only for critical alerts | Planned |
| Quiet hours and batching | Quiet hours per channel (no SMS at night unless critical), batching to avoid alert storms, and a test button per channel | Planned |
| Richer alert rules | More conditions on top of the existing threshold alerts | Planned |
| Saved searches | Save and share searches, also as a shortcut in the menu | Planned |
| Retention per category | For example firewall 90 days, Wi-Fi 30 days, IPS 1 year (ClickHouse TTL) | Planned |
| System status | Page with messages per second, disk usage, ClickHouse health and dropped packets | Planned |

## 1.1.x Branding and languages (shipped in v0.3.0)

Goal: the server in your own branding and in each user's language.

| Item | Description |
|---|---|
| Company name | Shown in the menu bar, on the login screen, in e-mails and in reports |
| Company logo | Upload an SVG or PNG under *Branding* in Settings, with separate light and dark variants and a custom favicon |
| Multilingual interface | Dutch and English to start. All texts live in translation files, so a new language needs no code change |
| Language choice | Default language per server; each user can pick their own. With Entra SSO the language of the Microsoft account is used |
| Multilingual e-mails | Alerts and reports are sent in the recipient's language |

## 1.1.y Release channels and rollback (shipped in v0.4.0)

Goal: try new versions safely first, and always be able to go back.

| Item | Description |
|---|---|
| Two channels | **Production** (stable releases) and **Test** (pre-releases such as `v0.4.0-beta.1`, published as GitHub pre-releases) |
| Channel switch in the interface | Choose the channel under *Info & updates*. Test also shows pre-releases; Production only stable ones |
| Back to production | Switching back offers the latest stable release, even if it is lower than the test version currently running |
| Rollback | A list of earlier versions with one-click rollback. Each update keeps the previous binary and a snapshot of the settings database |
| Safe schema changes | Changes to the log store (ClickHouse) are additive only, so an older version can still read the data |
| Automatic rollback | If a new version does not start properly within a few minutes, the server restores the previous one |
| Probes follow the main server | Remote probes (1.5) get their version and channel from the main server |

## 1.2 Deeper UniFi integration (shipped in v0.5.0)

Goal: enrich logs so you see *who* and *what* instead of only IP and MAC addresses.

| Item | Description |
|---|---|
| UniFi Network API | One API key per controller; fetch device and client names and attach them to log lines |
| MAC to client name | "Jan's iPhone" instead of `a4:83:e7:...` in Wi-Fi and DHCP logs |
| GeoIP | Country and AS number for external IPs (DB-IP Lite or MaxMind GeoLite2), with a map on the dashboard |
| Ready-made dashboards | Firewall, Wi-Fi (roaming, connection problems), DHCP, VPN (WireGuard, site-to-site) and IPS threats |
| More UniFi sources | UniFi Protect and UniFi Access logs, UniFi OS system events (CEF) |
| Firmware warnings | Alert when devices run mixed or outdated firmware |

## 1.3 Security and administration (in testing on the Test channel)

Goal: safe to use with several administrators and customers.

This milestone is being rolled out as a pre-release on the Test channel. It moves to Production once testing is complete.

| Item | Description |
|---|---|
| Roles and permissions | Administrator, analyst, read-only; permissions per site |
| Entra groups to roles | Assign roles automatically from Entra group membership |
| Audit log | Who viewed, changed, exported or restored what |
| Local 2FA | TOTP for local accounts when SSO is not used |
| API tokens | REST API for scripts and integrations, with per-user tokens |
| Source allowlist | Only accept syslog from known IPs or subnets |

## 1.4 Forwarding to Microsoft Sentinel, ELK and other log tools

Goal: forward selected UniFi events directly and reliably to Microsoft Sentinel, the ELK stack (Elasticsearch, Logstash, Kibana) or another log analytics tool. All destinations share the same filters, queue and status page.

| Item | Description |
|---|---|
| Logs Ingestion API | Connect through the Azure Monitor Logs Ingestion API with a Data Collection Rule (DCR). The legacy HTTP Data Collector API is not used because Microsoft is retiring it |
| Entra authentication | App registration with client secret or certificate, in the same Entra tenant as SSO |
| Forwarding filters | Choose per destination what is sent: by category (firewall, IPS, VPN, Wi-Fi), site, device, severity or a saved search, so you only pay for relevant data in Sentinel or Elastic |
| Alerts to Sentinel | Alert rules can use Sentinel as a channel next to e-mail and Teams |
| Table choice | A custom table (`UnifiSyslog_CL`) with all UniFi fields, or firewall and IPS events to the standard `CommonSecurityLog` table so existing Sentinel analytics rules work right away |
| Reliability | Batching, an on-disk queue and automatic retries, so no events are lost |
| Status and cost | Dashboard with forwarded events, errors and estimated daily volume |
| Sentinel content | Bundled KQL queries, a workbook and sample analytics rules for UniFi data |
| Elasticsearch | Direct delivery through the Bulk API into a data stream, with fields mapped to the Elastic Common Schema (ECS) so Elastic Security and existing dashboards understand them. API key authentication; also works with Elastic Cloud and OpenSearch |
| Logstash | Send JSON over TCP or HTTP to a Logstash input, for teams that keep their own pipelines and enrichment in Logstash |
| Kibana content | Bundled index template, Kibana dashboards and sample detection rules for UniFi data |
| Other log tools | Syslog forwarding (RFC 5424 over TCP, optionally TLS) and a generic JSON webhook, so Graylog, Wazuh, QRadar and similar tools work too. Splunk through the HTTP Event Collector |
| Multiple destinations | For example firewall and IPS events to Sentinel, and everything to Elastic for long-term storage |

## 1.5 Remote probes

Goal: a small probe at each site that receives UniFi logs locally, buffers them and forwards them reliably to the main server. No logs are lost when the internet link drops, and syslog never crosses the internet unencrypted.

| Item | Description |
|---|---|
| Local receiver | The probe listens on UDP and TCP 514 at the site; UniFi devices send syslog to the probe instead of the main server |
| Local buffer | Messages are buffered on disk (configurable size and age). During an outage nothing is lost; afterwards they are sent in order |
| Forwarding | Encrypted over HTTPS/TLS in compressed batches. The probe opens the connection, so no inbound port is needed at the site |
| Enrollment | Register a probe with a one-time code from the main server; it then gets its own key, which can be revoked. Logs are assigned to the right site automatically |
| Probe overview | A *Probes* page on the main server with per probe: site, online/offline, last contact, version, messages per second, buffer size, disk/CPU/memory and the number of devices behind it. Alerts when a probe goes offline or its buffer fills up |
| Installation | Proxmox LXC (Debian 13, same community-scripts flow), installer for a Debian 13 VM or physical machine, and a ready-made Raspberry Pi image (arm64) that asks for the enrollment code on first boot |
| Updates through the main server | Probes get their updates from the main server, not from the internet. Update all probes or a selection from the probe overview, with checksum verification and automatic rollback if the new version fails to start |
| Remote management | Change probe settings (buffer size, ports, log level) from the main server |

## 2.0 Scale and reliability

Goal: dozens of sites and billions of log lines without data loss.

| Item | Description |
|---|---|
| External or clustered ClickHouse | Storage on a separate server or a ClickHouse cluster for large environments |
| Cold storage | Move old logs to S3-compatible storage (e.g. MinIO, Wasabi) with ClickHouse tiered storage |
| More backup targets | SFTP and S3 next to FTP, FTPS and SCP; encrypted backups |
| Monitoring | Prometheus metrics endpoint and a Grafana data source |
| High availability | Two receivers behind a virtual IP (keepalived) |

## 2.x Analytics and compliance

Goal: insight and accountability, not just storage.

| Item | Description |
|---|---|
| Anomaly detection | Flag unusual patterns automatically (sudden spikes, new countries, new devices) |
| Scheduled reports | Weekly or monthly report per site by e-mail (PDF) |
| NIS2 compliance | Fixed retention periods, immutable storage and export for audits |
| Natural-language search | Optional: ask questions like "which clients had Wi-Fi problems at site X yesterday" |

---

## Up next

1. **Security and administration** (1.3): finish testing on the Test channel and release to Production.
2. **Notification channels** (1.1): Teams, Slack, Telegram and SMS via MessageBird next to e-mail, so the server tells you when something is wrong.
3. **Forwarding to Sentinel and ELK** (1.4): send selected UniFi events to the security tools you already use.
4. **Remote probes** (1.5): no lost logs from remote sites and no unencrypted syslog over the internet.
