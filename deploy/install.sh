#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# UniFi Syslog Server installer for Debian 13 (trixie): VM, bare metal or LXC.
#
#   curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/unifi-syslog-server/main/deploy/install.sh | bash
#
# Options (environment variables):
#   USS_VERSION=v1.2.3     install a specific release (default: latest)
#   USS_ADMIN_PASSWORD=..  initial admin password (default: generated)
#   USS_NONINTERACTIVE=1   no prompts
#   USS_CH_MEMORY_RATIO    ClickHouse share of RAM (default 0.5)
#   USS_HTTP_PORT=8080     port of the web interface
#
# Stages (USS_MODE), used by the Proxmox LXC template (deploy/lxc/build-template.sh):
#   full       everything below (default)
#   image      only what goes into a template: packages, ClickHouse and the program,
#              nothing that has to differ per server and no services started
#   firstboot  the rest, run once by unify-syslog-firstboot.service on the first boot:
#              passwords, configuration, admin account, start the services
#
# Logs on an external ClickHouse server or cluster instead of a local one
# (for example one set up with deploy/install-clickhouse.sh):
#   USS_CLICKHOUSE=external
#   USS_CH_ADDR=10.0.0.20:9000         native protocol (9440 with TLS); more servers comma separated
#   USS_CH_HTTP_URL=http://10.0.0.20:8123
#   USS_CH_USER=unify  USS_CH_PASSWORD=...  USS_CH_DATABASE=unify_syslog
#   USS_CH_SECURE=1                    use TLS (USS_CH_SKIP_VERIFY=1 for a self-signed certificate)
#   USS_CH_CLUSTER=name                store logs replicated on this cluster
# The connection can also be changed later under Administration > Storage.
set -euo pipefail

REPO="rhisijmuiden/unifi-syslog-server"
APP_DIR="/opt/unify-syslog"
CONF_DIR="/etc/unify-syslog"
DATA_DIR="/var/lib/unify-syslog"
SVC_USER="unify-syslog"
VERSION="${USS_VERSION:-latest}"
CH_MODE="${USS_CLICKHOUSE:-local}"
MANAGED_DIR="/var/lib/unify-syslog-ch"
MODE="${USS_MODE:-full}"
HTTP_PORT="${USS_HTTP_PORT:-8080}"
LIB_DIR="/usr/local/lib/unify-syslog"
CREDS=/root/unify-syslog.creds
case "$MODE" in full|image|firstboot) ;; *) echo "USS_MODE must be full, image or firstboot" >&2; exit 1 ;; esac
# Stage helpers: "builds" = this run installs software, "configures" = this run sets up this server.
builds()     { [[ "$MODE" != firstboot ]]; }
configures() { [[ "$MODE" != image ]]; }

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
    echo -e "${c_err}✘ Failed: $*${c_off}" >&2
    echo "----- last lines of $LOG -----" >&2
    tail -n 30 "$LOG" >&2
    echo "-----------------------------------" >&2
    return 1
  fi
}

[[ $EUID -eq 0 ]] || die "Run this script as root."
if configures && [[ ! -d /run/systemd/system ]]; then
  die "This system does not run systemd. Install on Debian 13 in a VM, on hardware or in an LXC container (Docker without systemd is not supported)."
fi
read -r OS_ID OS_VER OS_NAME < <(. /etc/os-release; echo "${ID:-} ${VERSION_ID:-} ${PRETTY_NAME:-unknown}")
if [[ "${OS_ID}" != "debian" ]]; then
  die "This script is meant for Debian 13 (found: ${OS_NAME})."
fi
if [[ "${OS_VER}" != "13" ]]; then
  warn "Tested on Debian 13, found ${OS_NAME}. Continuing..."
fi

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "Unsupported architecture $(uname -m)" ;;
esac

export DEBIAN_FRONTEND=noninteractive
: >"$LOG"

if [[ "$MODE" == full ]]; then
# ClickHouse needs about 2 GB on disk to install (the default Debian LXC disk is only 2 GB).
FREE_MB=$(df -Pm / | awk 'NR==2 {print $4}')
if [[ "$CH_MODE" == external ]]; then
  (( FREE_MB >= 1024 )) || die "Not enough disk space: ${FREE_MB} MB free on /. At least 1 GB is required."
elif (( FREE_MB < 3072 )); then
  die "Not enough disk space: ${FREE_MB} MB free on /. At least 3 GB is required, 20 GB or more is recommended. Grow the disk (Proxmox: Resources → Root Disk → Resize) and run again."
elif (( FREE_MB < 10240 )); then
  warn "Only ${FREE_MB} MB free on /. 20 GB or more is recommended for log storage."
fi
if [[ "$CH_MODE" == local && "$ARCH" == amd64 ]] && ! grep -qw sse4_2 /proc/cpuinfo; then
  die "The CPU does not support SSE4.2, which ClickHouse requires. In Proxmox, set the VM CPU type to 'host' or 'x86-64-v2-AES'."
fi
TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
(( TOTAL_MB >= 1800 )) || warn "Only ${TOTAL_MB} MB RAM. 4 GB or more is recommended."
fi

# ClickHouse 26.8 and later need AVX2 (Intel Haswell / AMD Zen or newer) and die with
# "Illegal instruction" on older CPUs such as the Xeon E5 v1/v2. 26.3 LTS still runs there.
# A template is built on one CPU and runs on another, so it always carries 26.3; the first
# boot lifts the pin again when the CPU has AVX2, so later upgrades move to the current LTS.
CH_PIN="${USS_CH_VERSION:-}"
if [[ "$CH_MODE" == local && -z "$CH_PIN" && "$ARCH" == amd64 ]]; then
  if [[ "$MODE" == image ]]; then
    CH_PIN="26.3.*"
  elif ! grep -qw avx2 /proc/cpuinfo; then
    CH_PIN="26.3.*"
    [[ "$MODE" == full ]] && warn "CPU without AVX2 detected: pinning ClickHouse to 26.3 LTS."
  fi
fi
install -d /etc/apt/preferences.d
if [[ -n "$CH_PIN" ]]; then
  printf 'Package: clickhouse-server clickhouse-client clickhouse-common-static clickhouse-keeper\nPin: version %s\nPin-Priority: 1001\n' "$CH_PIN" > /etc/apt/preferences.d/clickhouse
else
  rm -f /etc/apt/preferences.d/clickhouse
fi
if [[ "$MODE" == firstboot && "$CH_MODE" == local && "$ARCH" == amd64 ]] && ! grep -qw sse4_2 /proc/cpuinfo; then
  die "The CPU does not support SSE4.2, which ClickHouse requires. In Proxmox, set the CPU type of the host or VM to one with SSE4.2."
fi

if builds; then

# A ClickHouse package left half-configured by an earlier failed run blocks apt; remove it
# (data and config stay) so it is reinstalled below.
if dpkg -s clickhouse-server >/dev/null 2>&1 && ! dpkg -s clickhouse-server | grep -q 'Status: install ok installed'; then
  warn "Found a half-installed ClickHouse from an earlier attempt; reinstalling it."
  dpkg --remove --force-remove-reinstreq clickhouse-server >>"$LOG" 2>&1 || true
fi
dpkg --configure -a >>"$LOG" 2>&1 || true

info "Installing system packages"
run apt-get update || die "apt-get update failed"
run apt-get install -y curl ca-certificates gnupg apt-transport-https tar openssl tzdata libcap2-bin || die "Installing base packages failed"
ok "Base packages installed"
fi

if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi

# ---------------------------------------------------------------- ClickHouse
if [[ "$CH_MODE" == local ]]; then
if builds; then
ch_works() { dpkg -s clickhouse-server 2>/dev/null | grep -q 'Status: install ok installed' && clickhouse local -q 'SELECT 1' >/dev/null 2>&1; }
if ! ch_works; then
  info "Installing ClickHouse (official repository${CH_PIN:+, version $CH_PIN})"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL 'https://packages.clickhouse.com/rpm/lts/repodata/repomd.xml.key' | gpg --dearmor --yes -o /usr/share/keyrings/clickhouse-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/clickhouse-keyring.gpg arch=${ARCH}] https://packages.clickhouse.com/deb lts main" > /etc/apt/sources.list.d/clickhouse.list
  run apt-get update || die "apt-get update failed"
  if ! run apt-get install -y --allow-downgrades clickhouse-common-static clickhouse-server clickhouse-client; then
    run apt-get install -y -f || true
  fi
  if ! ch_works; then
    rc=0; clickhouse local -q 'SELECT 1' >/dev/null 2>&1 || rc=$?
    if (( rc == 132 )); then  # SIGILL
      die "ClickHouse does not run on this CPU. Try again with USS_CH_VERSION='26.3.*', or for a VM set the CPU type to 'host'."
    fi
    die "Installing ClickHouse failed. The full log is in $LOG"
  fi
  ok "ClickHouse installed"
else
  ok "ClickHouse is already installed"
fi
fi

if [[ "$MODE" == image ]]; then
  # Configured and started on the first boot, with a password of its own.
  systemctl disable -q clickhouse-server 2>/dev/null || true
  # A template only ever runs in LXC (see the note on capabilities below).
  install -d /etc/systemd/system/clickhouse-server.service.d
  cat > /etc/systemd/system/clickhouse-server.service.d/lxc.conf <<'EOF2'
[Service]
AmbientCapabilities=
CapabilityBoundingSet=
ExecStartPre=-+/usr/sbin/setcap -r /usr/bin/clickhouse
EOF2
  setcap -r /usr/bin/clickhouse 2>/dev/null || true
  install -d -m 2750 -o "$SVC_USER" -g clickhouse "$MANAGED_DIR"
fi

if configures; then
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
# Configuration the server writes itself (cold storage on S3, Administration > Storage):
# a directory it owns, readable by ClickHouse, linked into config.d.
install -d -m 2750 -o "$SVC_USER" -g clickhouse "$MANAGED_DIR"
[[ -f "$MANAGED_DIR/storage.xml" ]] || echo '<clickhouse/>' > "$MANAGED_DIR/storage.xml"
chown "$SVC_USER":clickhouse "$MANAGED_DIR/storage.xml"
chmod 0640 "$MANAGED_DIR/storage.xml"
ln -sfn "$MANAGED_DIR/storage.xml" /etc/clickhouse-server/config.d/zz-unify-syslog-managed.xml
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
clickhouse-client --user unify --password "$CH_PASS" -q "SELECT 1" >/dev/null 2>&1 || die "ClickHouse does not start; see journalctl -u clickhouse-server"
ok "ClickHouse is running (local access only)"
fi
elif configures; then
  CH_ADDR="${USS_CH_ADDR:?USS_CH_ADDR is required with USS_CLICKHOUSE=external}"
  CH_PASS="${USS_CH_PASSWORD:-}"
  ok "Using the external ClickHouse at ${CH_ADDR}"
fi

# ---------------------------------------------------------------- application
if builds; then
install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR" "$DATA_DIR/backups"

if [[ -n "${USS_LOCAL_TARBALL:-}" ]]; then
  TARBALL="$USS_LOCAL_TARBALL"
else
  if [[ "$VERSION" == "latest" ]]; then
    # Follow the /releases/latest redirect (no API rate limit, no grep closing the pipe early).
    LATEST_URL="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" || true)"
    VERSION="${LATEST_URL##*/tag/}"
    [[ "$LATEST_URL" == */tag/* ]] || VERSION=""
    [[ -n "$VERSION" ]] || die "Could not determine the latest release (are there releases on github.com/${REPO}?)"
  fi
  info "Downloading UniFi Syslog Server ${VERSION}"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  ASSET="unify-syslog-server_linux_${ARCH}.tar.gz"
  BASE="https://github.com/${REPO}/releases/download/${VERSION}"
  curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET"
  if curl -fsSL -o "$TMP/checksums.txt" "$BASE/checksums.txt"; then
    (cd "$TMP" && grep " ${ASSET}\$" checksums.txt | sha256sum -c --quiet -) || die "Checksum mismatch"
  fi
  TARBALL="$TMP/$ASSET"
fi
tar -xzf "$TARBALL" -C "$APP_DIR" unify-syslog
chmod 0755 "$APP_DIR/unify-syslog"
chown "$SVC_USER:$SVC_USER" "$APP_DIR/unify-syslog"
ln -sf "$APP_DIR/unify-syslog" /usr/local/bin/unify-syslog
ok "Program installed in $APP_DIR ($("$APP_DIR/unify-syslog" version))"
fi

install -d -m 0750 "$CONF_DIR"
if configures && [[ ! -f "$CONF_DIR/config.yaml" ]]; then
  if [[ "$CH_MODE" == local ]]; then
    CH_YAML="  addr: \"127.0.0.1:9000\"
  http_url: \"http://127.0.0.1:8123\"
  database: unify_syslog
  username: unify
  password: \"${CH_PASS}\""
  else
    IFS=',' read -r -a CH_ADDRS <<<"$CH_ADDR"
    CH_HOST="${CH_ADDRS[0]%:*}"
    CH_HTTP="${USS_CH_HTTP_URL:-}"
    if [[ -z "$CH_HTTP" ]]; then
      if [[ -n "${USS_CH_SECURE:-}" ]]; then CH_HTTP="https://${CH_HOST}:8443"; else CH_HTTP="http://${CH_HOST}:8123"; fi
    fi
    CH_YAML="  addr: \"${CH_ADDRS[0]}\""
    if (( ${#CH_ADDRS[@]} > 1 )); then
      CH_YAML+=$'\n  addrs:'
      for a in "${CH_ADDRS[@]:1}"; do CH_YAML+=$'\n    - "'"$a"'"'; done
    fi
    CH_YAML+="
  http_url: \"${CH_HTTP}\"
  database: ${USS_CH_DATABASE:-unify_syslog}
  username: \"${USS_CH_USER:-unify}\"
  password: \"${CH_PASS}\""
    if [[ -n "${USS_CH_SECURE:-}" ]]; then CH_YAML+=$'\n  secure: true'; fi
    if [[ -n "${USS_CH_SKIP_VERIFY:-}" ]]; then CH_YAML+=$'\n  skip_verify: true'; fi
    if [[ -n "${USS_CH_CLUSTER:-}" ]]; then CH_YAML+=$'\n  cluster: "'"${USS_CH_CLUSTER}"'"'; fi
  fi
  cat > "$CONF_DIR/config.yaml" <<EOF
# UniFi Syslog Server - bootstrap configuration.
# All other settings are managed in the web interface.
http_listen: ":${HTTP_PORT}"
data_dir: ${DATA_DIR}
syslog:
  udp: ":514"
  tcp: ":514"
  udp_read_buffer: 33554432
clickhouse:
${CH_YAML}
ingest:
  queue_size: 200000
  workers: $(nproc)
  batch_size: 20000
  flush_interval_ms: 1000
EOF
fi
chown root:"$SVC_USER" "$CONF_DIR"
if [[ -f "$CONF_DIR/config.yaml" ]]; then
  chown root:"$SVC_USER" "$CONF_DIR/config.yaml"
  chmod 0640 "$CONF_DIR/config.yaml"
  # The port the web interface really listens on (the file may predate USS_HTTP_PORT).
  p="$(sed -n 's/^http_listen: *"\{0,1\}[^:"]*:\([0-9][0-9]*\)"\{0,1\}.*/\1/p' "$CONF_DIR/config.yaml" | head -n1)"
  [[ -n "$p" ]] && HTTP_PORT="$p"
fi

# Larger socket buffers so bursts from many sites are not dropped by the kernel.
cat > /etc/sysctl.d/90-unify-syslog.conf <<EOF
net.core.rmem_max = 33554432
net.core.rmem_default = 8388608
EOF
if configures; then
  sysctl -q -p /etc/sysctl.d/90-unify-syslog.conf 2>/dev/null || warn "sysctl not applied (normal in an unprivileged LXC): run \"echo net.core.rmem_max = 33554432 > /etc/sysctl.d/90-unify-syslog.conf && sysctl --system\" on the Proxmox host"
fi

UNIT_CH=""
[[ "$CH_MODE" == local ]] && UNIT_CH=" clickhouse-server.service"
cat > /etc/systemd/system/unify-syslog.service <<EOF
[Unit]
Description=UniFi Syslog Server
Documentation=https://github.com/${REPO}
After=network-online.target${UNIT_CH}
Wants=network-online.target${UNIT_CH}

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

# ---------------------------------------------------------------- console banner
# The console (and the Proxmox console of a container) shows the web address and the
# initial login above the login prompt; so does the message after an SSH login.
install -d -m 0755 "$LIB_DIR" /etc/issue.d /etc/update-motd.d
cat > "$LIB_DIR/banner" <<'EOF'
#!/bin/sh
# Prints the web address and the initial login of the UniFi Syslog Server.
#   banner         for the message after login (current IP address)
#   banner issue   for /etc/issue.d (getty fills in the IP address with \4)
CREDS=/root/unify-syslog.creds
say() { printf '%s\n' "$*"; }
port="$(sed -n 's/^http_listen: *"\{0,1\}[^:"]*:\([0-9][0-9]*\)"\{0,1\}.*/\1/p' /etc/unify-syslog/config.yaml 2>/dev/null | head -n1)"
[ -n "$port" ] || port=8080
if [ "$1" = issue ]; then
  host='\4'
else
  host="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$host" ] || host="<this server's IP address>"
fi
say ""
say "  UniFi Syslog Server"
if [ -f /etc/unify-syslog/.firstboot ]; then
  if systemctl is-failed -q unify-syslog-firstboot.service 2>/dev/null; then
    say "  Setup failed. Details: journalctl -u unify-syslog-firstboot"
  else
    say "  Setting up; this takes a minute. Press Enter to refresh."
  fi
  say ""
  exit 0
fi
say "  Web interface:  http://$host:$port"
if [ -r "$CREDS" ]; then
  user="$(sed -n 's/^User: *//p' "$CREDS")"
  pass="$(sed -n 's/^Password: *//p' "$CREDS")"
  # getty reads backslashes as escapes.
  [ "$1" = issue ] && pass="$(printf '%s' "$pass" | sed 's/\\/\\\\/g')"
  say "  User:           $user"
  say "  Password:       $pass"
fi
say ""
EOF
chmod 0755 "$LIB_DIR/banner"
cat > /etc/update-motd.d/90-unify-syslog <<EOF
#!/bin/sh
exec $LIB_DIR/banner
EOF
chmod 0755 /etc/update-motd.d/90-unify-syslog
cat > /etc/systemd/system/unify-syslog-banner.service <<EOF
[Unit]
Description=UniFi Syslog Server console banner
After=unify-syslog-firstboot.service
Before=getty.target getty@tty1.service console-getty.service container-getty@1.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c '${LIB_DIR}/banner issue > /etc/issue.d/unify-syslog.issue'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

if [[ "$MODE" == image ]]; then
  # The first boot finishes the installation with this same script.
  install -m 0755 "$0" "$LIB_DIR/install.sh"
  install -d -m 0750 "$CONF_DIR"
  touch "$CONF_DIR/.firstboot"
  printf '\n  UniFi Syslog Server\n  Setting up; this takes a minute. Press Enter to refresh.\n\n' > /etc/issue.d/unify-syslog.issue
  cat > /etc/systemd/system/unify-syslog-firstboot.service <<EOF
[Unit]
Description=UniFi Syslog Server first-boot setup
ConditionPathExists=${CONF_DIR}/.firstboot
After=local-fs.target network.target
Before=unify-syslog-banner.service getty.target

[Service]
Type=oneshot
Environment=USS_MODE=firstboot USS_NONINTERACTIVE=1
ExecStart=/bin/bash ${LIB_DIR}/install.sh
RemainAfterExit=yes
TimeoutStartSec=15min
StandardOutput=journal+console

[Install]
WantedBy=multi-user.target
EOF
  systemctl enable -q unify-syslog-firstboot.service unify-syslog-banner.service
  ok "Template stage done; the first boot finishes the installation"
  exit 0
fi

systemctl daemon-reload
systemctl enable -q unify-syslog-banner.service

FIRST_RUN=0
if [[ ! -f "$DATA_DIR/meta.db" ]]; then
  FIRST_RUN=1
  ADMIN_PW="${USS_ADMIN_PASSWORD:-$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)}"
  sudo_u() { runuser -u "$SVC_USER" -- "$@"; }
  echo "$ADMIN_PW" | sudo_u "$APP_DIR/unify-syslog" -c "$CONF_DIR/config.yaml" user add admin --admin
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "$IP" ]] || IP="<this server's IP address>"
  cat > "$CREDS" <<EOF
UniFi Syslog Server
Web:        http://${IP}:${HTTP_PORT}
User:       admin
Password:   ${ADMIN_PW}
EOF
  chmod 0600 "$CREDS"
fi

systemctl enable -q unify-syslog
systemctl restart unify-syslog
sleep 2
systemctl is-active -q unify-syslog || die "The service does not start; see journalctl -u unify-syslog"
rm -f "$CONF_DIR/.firstboot"
# Written directly: on the first boot the banner unit waits for this script (restarting it would deadlock).
"$LIB_DIR/banner" issue > /etc/issue.d/unify-syslog.issue || true

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -n "$IP" ]] || IP="<this server's IP address>"
echo
ok "UniFi Syslog Server is installed"
echo
echo -e "   Web interface:  ${c_info}http://${IP}:${HTTP_PORT}${c_off}"
if [[ $FIRST_RUN -eq 1 ]]; then
  echo -e "   User:           admin"
  echo -e "   Password:       ${c_ok}${ADMIN_PW}${c_off}"
else
  echo -e "   Login:          unchanged (the initial one is in ${CREDS})"
fi
echo
