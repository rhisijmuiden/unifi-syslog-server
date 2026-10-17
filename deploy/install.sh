#!/usr/bin/env bash
# UniFi Syslog Server installer for Debian 13 (trixie): VM, bare metal or LXC.
#
#   curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/unify-syslog-server/main/deploy/install.sh | bash
#
# Options (environment variables):
#   USS_VERSION=v1.2.3     install a specific release (default: latest)
#   USS_ADMIN_PASSWORD=..  initial admin password (default: generated)
#   USS_NONINTERACTIVE=1   no prompts
#   USS_CH_MEMORY_RATIO    ClickHouse share of RAM (default 0.5)
set -euo pipefail

REPO="rhisijmuiden/unify-syslog-server"
APP_DIR="/opt/unify-syslog"
CONF_DIR="/etc/unify-syslog"
DATA_DIR="/var/lib/unify-syslog"
SVC_USER="unify-syslog"
VERSION="${USS_VERSION:-latest}"

c_ok="\e[32m"; c_info="\e[36m"; c_warn="\e[33m"; c_err="\e[31m"; c_off="\e[0m"
info() { echo -e "${c_info}==>${c_off} $*"; }
ok()   { echo -e "${c_ok}✔${c_off} $*"; }
warn() { echo -e "${c_warn}!${c_off} $*"; }
die()  { echo -e "${c_err}✘ $*${c_off}" >&2; exit 1; }

LOG=/var/log/unify-syslog-install.log
# Run a command with its output in $LOG; on failure show the tail so the cause is visible.
run() {
  echo "+ $*" >>"$LOG"
  if ! "$@" >>"$LOG" 2>&1; then
    echo -e "${c_err}✘ Mislukt: $*${c_off}" >&2
    echo "----- laatste regels van $LOG -----" >&2
    tail -n 30 "$LOG" >&2
    echo "-----------------------------------" >&2
    return 1
  fi
}

[[ $EUID -eq 0 ]] || die "Voer dit script uit als root."
read -r OS_ID OS_VER OS_NAME < <(. /etc/os-release; echo "${ID:-} ${VERSION_ID:-} ${PRETTY_NAME:-onbekend}")
if [[ "${OS_ID}" != "debian" ]]; then
  die "Dit script is bedoeld voor Debian 13 (gevonden: ${OS_NAME})."
fi
if [[ "${OS_VER}" != "13" ]]; then
  warn "Getest op Debian 13, gevonden ${OS_NAME}. Doorgaan..."
fi

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Niet-ondersteunde architectuur $(uname -m)" ;;
esac

export DEBIAN_FRONTEND=noninteractive
: >"$LOG"

# ClickHouse needs about 2 GB on disk to install (the default Debian LXC disk is only 2 GB).
FREE_MB=$(df -Pm / | awk 'NR==2 {print $4}')
if (( FREE_MB < 3072 )); then
  die "Te weinig schijfruimte: ${FREE_MB} MB vrij op /. Minimaal 3 GB nodig, 20 GB of meer aangeraden. Vergroot de schijf (Proxmox: Resources → Root Disk → Resize) en start opnieuw."
elif (( FREE_MB < 10240 )); then
  warn "Maar ${FREE_MB} MB vrij op /. Voor logopslag is 20 GB of meer aangeraden."
fi
if [[ "$ARCH" == amd64 ]] && ! grep -qw sse4_2 /proc/cpuinfo; then
  die "De CPU ondersteunt geen SSE4.2, wat ClickHouse vereist. Zet in Proxmox het CPU-type van de VM op 'host' of 'x86-64-v2-AES'."
fi
TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
(( TOTAL_MB >= 1800 )) || warn "Maar ${TOTAL_MB} MB RAM. 4 GB of meer is aangeraden."

# ClickHouse 26.8 and later need AVX2 (Intel Haswell / AMD Zen or newer) and die with
# "Illegal instruction" on older CPUs such as the Xeon E5 v1/v2. 26.3 LTS still runs there.
CH_PIN="${USS_CH_VERSION:-}"
if [[ -z "$CH_PIN" && "$ARCH" == amd64 ]] && ! grep -qw avx2 /proc/cpuinfo; then
  CH_PIN="26.3.*"
  warn "CPU zonder AVX2 gevonden: ClickHouse wordt vastgezet op 26.3 LTS."
fi
install -d /etc/apt/preferences.d
if [[ -n "$CH_PIN" ]]; then
  printf 'Package: clickhouse-server clickhouse-client clickhouse-common-static clickhouse-keeper\nPin: version %s\nPin-Priority: 1001\n' "$CH_PIN" > /etc/apt/preferences.d/clickhouse
else
  rm -f /etc/apt/preferences.d/clickhouse
fi

# A ClickHouse package left half-configured by an earlier failed run blocks apt; remove it
# (data and config stay) so it is reinstalled below.
if dpkg -s clickhouse-server >/dev/null 2>&1 && ! dpkg -s clickhouse-server | grep -q 'Status: install ok installed'; then
  warn "Half geïnstalleerde ClickHouse van een eerdere poging gevonden, wordt opnieuw geïnstalleerd."
  dpkg --remove --force-remove-reinstreq clickhouse-server >>"$LOG" 2>&1 || true
fi
dpkg --configure -a >>"$LOG" 2>&1 || true

info "Systeempakketten installeren"
run apt-get update || die "apt-get update mislukt"
run apt-get install -y curl ca-certificates gnupg apt-transport-https tar openssl tzdata libcap2-bin || die "Basispakketten installeren mislukt"
ok "Basispakketten geïnstalleerd"

# ---------------------------------------------------------------- ClickHouse
ch_works() { dpkg -s clickhouse-server 2>/dev/null | grep -q 'Status: install ok installed' && clickhouse local -q 'SELECT 1' >/dev/null 2>&1; }
if ! ch_works; then
  info "ClickHouse installeren (officiële repository${CH_PIN:+, versie $CH_PIN})"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL 'https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key' | gpg --dearmor --yes -o /usr/share/keyrings/clickhouse-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg arch=${ARCH}] https://packages.clickhouse.com/deb lts main" > /etc/apt/sources.list.d/clickhouse.list
  run apt-get update || die "apt-get update mislukt"
  if ! run apt-get install -y --allow-downgrades clickhouse-common-static clickhouse-server clickhouse-client; then
    run apt-get install -y -f || true
  fi
  if ! ch_works; then
    rc=0; clickhouse local -q 'SELECT 1' >/dev/null 2>&1 || rc=$?
    if (( rc == 132 )); then  # SIGILL
      die "ClickHouse draait niet op deze CPU. Probeer opnieuw met USS_CH_VERSION='26.3.*' of zet bij een VM het CPU-type op 'host'."
    fi
    die "ClickHouse installeren mislukt. Het volledige log staat in $LOG"
  fi
  ok "ClickHouse geïnstalleerd"
else
  ok "ClickHouse is al aanwezig"
fi

CH_PASS_FILE="${CONF_DIR}/.clickhouse-password"
install -d -m 0750 "$CONF_DIR"
if [[ -s "$CH_PASS_FILE" ]]; then
  CH_PASS="$(cat "$CH_PASS_FILE")"
else
  CH_PASS="$(openssl rand -hex 24)"
  echo -n "$CH_PASS" > "$CH_PASS_FILE"
  chmod 0600 "$CH_PASS_FILE"
fi
CH_HASH="$(echo -n "$CH_PASS" | sha256sum | cut -d' ' -f1)"

MEM_RATIO="${USS_CH_MEMORY_RATIO:-0.5}"
install -d -m 0755 /etc/clickhouse-server/config.d /etc/clickhouse-server/users.d
cat > /etc/clickhouse-server/config.d/unify-syslog.xml <<EOF
<clickhouse>
  <!-- Managed by unify-syslog installer -->
  <listen_host>127.0.0.1</listen_host>
  <listen_host>::1</listen_host>
  <max_server_memory_usage_to_ram_ratio>${MEM_RATIO}</max_server_memory_usage_to_ram_ratio>
  <mark_cache_size>268435456</mark_cache_size>
  <logger><level>warning</level><size>100M</size><count>3</count></logger>
  <!-- Keep system log tables small; they otherwise grow without bound. -->
  <query_log replace="1"><database>system</database><table>query_log</table><ttl>event_date + INTERVAL 3 DAY DELETE</ttl><flush_interval_milliseconds>7500</flush_interval_milliseconds></query_log>
  <trace_log remove="1"/>
  <metric_log remove="1"/>
  <asynchronous_metric_log remove="1"/>
  <text_log remove="1"/>
  <part_log remove="1"/>
  <processors_profile_log remove="1"/>
  <latency_log remove="1"/>
  <error_log remove="1"/>
  <query_metric_log remove="1"/>
</clickhouse>
EOF
cat > /etc/clickhouse-server/users.d/unify-syslog.xml <<EOF
<clickhouse>
  <users>
    <default remove="1"/>
    <unify>
      <password_sha256_hex>${CH_HASH}</password_sha256_hex>
      <networks><ip>127.0.0.1</ip><ip>::1</ip></networks>
      <profile>default</profile>
      <quota>default</quota>
      <access_management>0</access_management>
    </unify>
  </users>
</clickhouse>
EOF
rm -f /etc/clickhouse-server/users.d/default-password.xml
chown -R clickhouse:clickhouse /etc/clickhouse-server/config.d /etc/clickhouse-server/users.d 2>/dev/null || true
if [[ "$(systemd-detect-virt -c 2>/dev/null || true)" == "lxc" ]]; then
  # Unprivileged containers cannot grant ClickHouse's extra capabilities; it runs fine without.
  # The package puts file capabilities on the binary (again on every upgrade), and a binary
  # with file capabilities outside the bounding set cannot be executed, so strip them first.
  install -d /etc/systemd/system/clickhouse-server.service.d
  cat > /etc/systemd/system/clickhouse-server.service.d/lxc.conf <<'EOF2'
[Service]
AmbientCapabilities=
CapabilityBoundingSet=
ExecStartPre=-+/usr/sbin/setcap -r /usr/bin/clickhouse
EOF2
  setcap -r /usr/bin/clickhouse 2>/dev/null || true
  systemctl daemon-reload
fi
systemctl enable -q clickhouse-server
systemctl restart clickhouse-server
for _ in $(seq 1 60); do
  clickhouse-client --user unify --password "$CH_PASS" -q "SELECT 1" >/dev/null 2>&1 && break
  sleep 1
done
clickhouse-client --user unify --password "$CH_PASS" -q "SELECT 1" >/dev/null 2>&1 || die "ClickHouse start niet; zie journalctl -u clickhouse-server"
ok "ClickHouse draait (alleen lokaal bereikbaar)"

# ---------------------------------------------------------------- application
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi
install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR" "$DATA_DIR/backups"

if [[ -n "${USS_LOCAL_TARBALL:-}" ]]; then
  TARBALL="$USS_LOCAL_TARBALL"
else
  if [[ "$VERSION" == "latest" ]]; then
    VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4)"
    [[ -n "$VERSION" ]] || die "Kon de nieuwste release niet bepalen (zijn er releases op github.com/${REPO}?)"
  fi
  info "UniFi Syslog Server ${VERSION} downloaden"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  ASSET="unify-syslog-server_linux_${ARCH}.tar.gz"
  BASE="https://github.com/${REPO}/releases/download/${VERSION}"
  curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET"
  if curl -fsSL -o "$TMP/checksums.txt" "$BASE/checksums.txt"; then
    (cd "$TMP" && grep " ${ASSET}\$" checksums.txt | sha256sum -c --quiet -) || die "Checksum klopt niet"
  fi
  TARBALL="$TMP/$ASSET"
fi
tar -xzf "$TARBALL" -C "$APP_DIR" unify-syslog
chmod 0755 "$APP_DIR/unify-syslog"
chown "$SVC_USER:$SVC_USER" "$APP_DIR/unify-syslog"
ln -sf "$APP_DIR/unify-syslog" /usr/local/bin/unify-syslog
ok "Programma geïnstalleerd in $APP_DIR ($("$APP_DIR/unify-syslog" version))"

if [[ ! -f "$CONF_DIR/config.yaml" ]]; then
  cat > "$CONF_DIR/config.yaml" <<EOF
# UniFi Syslog Server - bootstrap configuratie.
# Alle overige instellingen beheer je in de webinterface.
http_listen: ":8080"
data_dir: ${DATA_DIR}
syslog:
  udp: ":514"
  tcp: ":514"
  udp_read_buffer: 8388608
clickhouse:
  addr: "127.0.0.1:9000"
  http_url: "http://127.0.0.1:8123"
  database: unify_syslog
  username: unify
  password: "${CH_PASS}"
ingest:
  queue_size: 200000
  workers: $(nproc)
  batch_size: 20000
  flush_interval_ms: 1000
EOF
fi
chown root:"$SVC_USER" "$CONF_DIR" "$CONF_DIR/config.yaml"
chmod 0640 "$CONF_DIR/config.yaml"

# Larger socket buffers so bursts from many sites are not dropped by the kernel.
cat > /etc/sysctl.d/90-unify-syslog.conf <<EOF
net.core.rmem_max = 33554432
net.core.rmem_default = 8388608
EOF
sysctl -q -p /etc/sysctl.d/90-unify-syslog.conf 2>/dev/null || warn "sysctl niet toegepast (normaal in een unprivileged LXC)"

cat > /etc/systemd/system/unify-syslog.service <<EOF
[Unit]
Description=UniFi Syslog Server
Documentation=https://github.com/${REPO}
After=network-online.target clickhouse-server.service
Wants=network-online.target clickhouse-server.service

[Service]
User=${SVC_USER}
Group=${SVC_USER}
ExecStart=${APP_DIR}/unify-syslog -c ${CONF_DIR}/config.yaml serve
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${DATA_DIR} ${APP_DIR}
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

FIRST_RUN=0
if [[ ! -f "$DATA_DIR/meta.db" ]]; then
  FIRST_RUN=1
  ADMIN_PW="${USS_ADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)}"
  sudo_u() { runuser -u "$SVC_USER" -- "$@"; }
  echo "$ADMIN_PW" | sudo_u "$APP_DIR/unify-syslog" -c "$CONF_DIR/config.yaml" user add admin --admin
  cat > /root/unify-syslog.creds <<EOF
UniFi Syslog Server
Web:        http://$(hostname -I | awk '{print $1}'):8080
Gebruiker:  admin
Wachtwoord: ${ADMIN_PW}
EOF
  chmod 0600 /root/unify-syslog.creds
fi

systemctl enable -q unify-syslog
systemctl restart unify-syslog
sleep 2
systemctl is-active -q unify-syslog || die "De dienst start niet; zie journalctl -u unify-syslog"

IP="$(hostname -I | awk '{print $1}')"
echo
ok "Installatie voltooid!"
echo -e "   Webinterface:  ${c_info}http://${IP}:8080${c_off}"
echo -e "   Syslog:        UDP/TCP ${IP}:514"
if [[ $FIRST_RUN -eq 1 ]]; then
  echo -e "   Inloggen:      admin / ${c_ok}${ADMIN_PW}${c_off}   (ook opgeslagen in /root/unify-syslog.creds)"
fi
echo -e "   Bijwerken:     via Info & updates in de webinterface, of: unify-syslog update && systemctl restart unify-syslog"
