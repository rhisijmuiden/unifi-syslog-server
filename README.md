# Unify Syslog Server

Een centrale syslog-server die speciaal is gebouwd voor UniFi. Alle UniFi-locaties sturen hun syslog naar één server; die herkent firewall-, IPS-, Wi-Fi-, DHCP-, DNS-, VPN-, switch- en beheerberichten, verrijkt ze met velden (bron, doel, poort, regel, client, SSID…) en maakt ze doorzoekbaar en zichtbaar in een dashboard.

- **Ontvanger**: UDP en TCP op poort 514 (RFC3164, RFC5424, RFC6587-framing).
- **UniFi-parser**: apparaatnaam `model,mac,versie`, iptables-regeltags (`WAN_IN-D-3001`, `DESCR="..."`), CEF uit UniFi Network SIEM, hostapd/stahtd, dnsmasq/kea DHCP, DNS, Suricata IPS, WireGuard/OpenVPN/IPsec, SSH-logins, switch-poorten en `EVT_*`-controllercodes.
- **Opslag**: ClickHouse (kolomopslag, compressie, miljarden regels), partities per dag en een instelbare bewaartermijn. Metadata in SQLite.
- **Dashboard**: berichten per categorie, geblokkeerde bronnen en poorten, IPS-signaturen, Wi-Fi-clients, SSID's, DHCP-clients, apparaten en locaties. Klik door naar de logs.
- **Zoeken**: een eigen zoektaal met velden, CIDR, bereiken en wildcards, live tail, en export naar CSV en JSON.
- **Categorieën**: maak eigen categorieën (een opgeslagen zoekopdracht met kleur) om logs te filteren.
- **Locaties**: bron-IP's koppelen aan een site, handmatig of via IP-bereiken. Ook locaties achter NAT werken.
- **Alerts**: e-mail wanneer een zoekopdracht een drempel overschrijdt.
- **Microsoft Entra SSO** (OIDC + PKCE), met groepen die worden gekoppeld aan rollen (admin of viewer).
- **Mail**: een eigen SMTP-server met STARTTLS of TLS, minimaal TLS 1.2/1.3, en PLAIN, LOGIN, CRAM-MD5, SCRAM-SHA-256 of OAuth2 (Microsoft 365).
- **Backup**: volledige en incrementele backups naar FTP, FTPS, SCP of een lokale map, met planning, bewaarbeleid en herstel vanaf de externe locatie.
- **Updates**: de knop Info toont de versie, zoekt naar updates en installeert ze vanuit de interface.
- De webinterface draait op **poort 8080**.

## Installatie

### Proxmox LXC

Draai dit op de Proxmox-host:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/unify-syslog-server/main/ct/unify-syslog-server.sh)"
```

Het script gebruikt de community-scripts-engine en maakt een unprivileged Debian 13-container aan (standaard 4 vCPU, 4 GB RAM en 40 GB schijf). Met *Advanced* kun je dat aanpassen. Kies de schijf naar verwachting: met UniFi-logs is dat grofweg 1 GB per 10 miljoen berichten na compressie.

Je kunt de container later bijwerken door hetzelfde commando in de container te draaien, of met de knop **Info** in de webinterface.

### Debian 13 (VM of fysieke server)

Draai dit als root:

```bash
curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/unify-syslog-server/main/deploy/install.sh | bash
```

Het installatiescript:

1. installeert ClickHouse en stelt het in (alleen bereikbaar op localhost, met een eigen gebruiker en wachtwoord);
2. downloadt de nieuwste release en controleert de checksum;
3. installeert een systemd-service `unify-syslog`;
4. maakt een admin-account aan en zet de inloggegevens in `/root/unify-syslog.creds`.

Je kunt het gedrag aanpassen met deze omgevingsvariabelen:

| Variabele | Betekenis |
|---|---|
| `USS_VERSION=v0.1.0` | Installeert een specifieke versie in plaats van de nieuwste. |
| `USS_ADMIN_PASSWORD=...` | Stelt het eerste admin-wachtwoord in (anders wordt het gegenereerd). |
| `USS_NONINTERACTIVE=1` | Slaat alle vragen over. |
| `USS_CH_MEMORY_RATIO=0.5` | Stelt in welk deel van het RAM ClickHouse mag gebruiken. |

Open daarna `http://<server>:8080`.

### Bestanden

| Pad | Inhoud |
|---|---|
| `/etc/unify-syslog/config.yaml` | Poorten, ClickHouse-verbinding en ingest-instellingen. |
| `/var/lib/unify-syslog/` | Metadata (`meta.db`), de encryptiesleutel (`secret.key`) en lokale backups. |
| `/opt/unify-syslog/` | Het programma. |

## UniFi instellen

**UniFi Network (controller, UDM, UCG, Cloud Key)**

1. Ga naar *Settings → CyberSecure → Traffic Logging* (in oudere versies *Settings → System → Advanced → Remote Logging*).
2. Kies **SIEM Server** of **Syslog**, vul het IP-adres van deze server in, gebruik poort `514` en sla op.
3. Zet bij de firewallregels die je wilt zien de optie **Syslog Logging** aan.
4. Wil je ook debug-berichten van de apparaten ontvangen, zet dan *Debug Logs* aan.

**Meerdere locaties**: elke locatie stuurt naar het publieke IP of de VPN-tunnel van deze server. Ga daarna in de interface naar **Locaties** en koppel elk bron-IP (bijvoorbeeld het WAN-IP van een vestiging) of IP-bereik aan een sitenaam.

## Zoektaal

| Voorbeeld | Betekenis |
|---|---|
| `category:firewall action:block` | Geblokkeerd firewallverkeer. |
| `src:203.0.113.0/24` | Bron-IP in een subnet. |
| `dport:22 OR dport:3389` | SSH of RDP. |
| `-category:dns` | Alles behalve DNS. |
| `rule:"WAN_IN-D-*"` | Een wildcard. |
| `severity:<=warning` | De ernst warning of hoger. |
| `dport:1..1024` | Een poortbereik. |
| `ssid:"Kantoor" client:aa:bb:*` | Een SSID en clients met een MAC-prefix. |
| `"authentication failure"` | Een exacte zin in het bericht. |
| `field.signature_id:2210050` | Een extra veld van de parser. |

Je kunt op deze velden zoeken:

| Groep | Velden |
|---|---|
| Algemeen | `category`, `app`, `host`, `site`, `source`, `severity`, `facility`, `msg`, `raw` |
| Apparaat | `model`, `mac`, `firmware` |
| Gebeurtenis | `action`, `rule`, `event` |
| Verkeer | `src`, `dst`, `sport`, `dport`, `proto`, `in`, `out`, `ip` (bron of doel), `port` |
| Clients | `client`, `client_name`, `client_ip`, `ssid` |

## Backup en herstel

Stel backups in via **Backup** in de webinterface.

- **Volledige backup**: alle logs plus de configuratie (gebruikers, instellingen, categorieën en de encryptiesleutel).
- **Incrementele backup**: alleen wat sinds de vorige backup in de keten is binnengekomen.
- **Herstel**: kies een backup op de externe locatie. De server haalt de hele keten op (de volledige backup plus de incrementele backups), zet de logs terug en herstart.

Een backup bevat de encryptiesleutel. Bewaar backups daarom op een vertrouwde locatie.

## Commandoregel

```bash
unify-syslog user add jan --admin       # gebruiker aanmaken
unify-syslog user passwd admin          # wachtwoord resetten
unify-syslog update [--check]           # bijwerken naar de nieuwste release
unify-syslog simulate --target 127.0.0.1:514 --rate 500 --sites 3   # testverkeer
unify-syslog version
```

## Zelf bouwen

Vereisten: Go 1.26 en Node 22.

```bash
make web      # React-UI bouwen (web/dist, ingebed in de binary)
make build    # bin/unify-syslog
make test
make dist     # release-tarballs voor amd64 en arm64 met checksums.txt
```

Een tag `v*` laat GitHub Actions een release maken. Het installatiescript en de updater gebruiken die release.

## Architectuur

```
UniFi-apparaten ──UDP/TCP 514──▶ syslogd ─▶ ingest-workers (UniFi-parser, site)
                                              │ batches van 20k / 1 s
                                              ▼
                       ClickHouse  logs (MergeTree, TTL) + logs_hourly (MV)
                                              ▲
       Browser ──HTTP 8080──▶ API + React-UI ─┘   SQLite: gebruikers, instellingen, sites
```
