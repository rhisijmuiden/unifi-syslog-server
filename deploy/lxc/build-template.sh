#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the Proxmox VE container template of the UniFi Syslog Server: a Debian 13
# (trixie) root file system with ClickHouse and the server installed but not yet
# configured. On the first boot unify-syslog-firstboot.service creates the passwords,
# the configuration and the admin account, and the console shows the web address and
# the login.
#
#   sudo deploy/lxc/build-template.sh <server amd64 tarball> <output.tar.zst>
#
# Needs root, mmdebstrap and zstd on a Debian or Ubuntu machine (CI runs it in a
# debian:trixie container). Options (environment variables):
#   MIRROR      Debian mirror (default http://deb.debian.org/debian)
#   KEEP_ROOT=1 keep the unpacked root file system and print ROOT=<dir> (for tests)
set -euo pipefail

TARBALL="$(realpath "$1")"
OUT="$(realpath -m "$2")"
MIRROR="${MIRROR:-http://deb.debian.org/debian}"
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALLER="$HERE/../install.sh"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
for c in mmdebstrap zstd tar; do command -v "$c" >/dev/null || { echo "missing $c" >&2; exit 1; }; done

WORK="$(mktemp -d /var/tmp/uss-lxc.XXXXXX)"
R="$WORK/rootfs"
cleanup() {
  local rc=$?
  for m in dev/pts dev proc sys; do umount -l "$R/$m" 2>/dev/null || true; done
  if [[ -n "${KEEP_ROOT:-}" && $rc -eq 0 ]]; then return; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# Roughly what Proxmox's own debian-13-standard template has: systemd, ifupdown with a
# DHCP client (Proxmox writes /etc/network/interfaces), SSH and the usual tools.
PKGS=(
  systemd systemd-sysv dbus libpam-systemd
  ifupdown isc-dhcp-client iproute2 iputils-ping
  openssh-server ca-certificates curl wget gnupg openssl tar libcap2-bin
  locales tzdata less nano vim-tiny procps bash-completion apt-utils cron logrotate
)
echo "==> Debian 13 base system"
mmdebstrap --variant=minbase --include="$(IFS=,; echo "${PKGS[*]}")" \
  --components=main --format=directory trixie "$R" \
  "deb $MIRROR trixie main" "deb $MIRROR trixie-updates main" \
  "deb http://security.debian.org/debian-security trixie-security main"

echo "==> UniFi Syslog Server"
for m in proc sys dev dev/pts; do mkdir -p "$R/$m"; done
mount -t proc proc "$R/proc"
mount --rbind /sys "$R/sys"
mount --bind /dev "$R/dev"
mount --bind /dev/pts "$R/dev/pts"
cp -L /etc/resolv.conf "$R/etc/resolv.conf"
# No services start inside the build.
printf '#!/bin/sh\nexit 101\n' > "$R/usr/sbin/policy-rc.d"
chmod 0755 "$R/usr/sbin/policy-rc.d"
install -m 0755 "$INSTALLER" "$R/root/install.sh"
cp "$TARBALL" "$R/root/server.tar.gz"
chroot "$R" env USS_MODE=image USS_NONINTERACTIVE=1 USS_LOCAL_TARBALL=/root/server.tar.gz \
  LANG=C.UTF-8 bash /root/install.sh
VERSION="$(chroot "$R" /opt/unify-syslog/unify-syslog version | awk '{print $2}')"
for m in dev/pts dev proc sys; do umount -l "$R/$m"; done

echo "==> Clean-up"
rm -f "$R/usr/sbin/policy-rc.d" "$R/root/install.sh" "$R/root/server.tar.gz"
# Per container: Proxmox writes the network, host name, DNS and SSH host keys;
# systemd creates a machine id on the first boot.
cat > "$R/etc/network/interfaces" <<'EOF'
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
EOF
echo localhost > "$R/etc/hostname"
: > "$R/etc/resolv.conf"
rm -f "$R"/etc/ssh/ssh_host_*
: > "$R/etc/machine-id"
rm -f "$R/var/lib/dbus/machine-id"
sed -i 's/^# *\(en_US.UTF-8\)/\1/' "$R/etc/locale.gen"
chroot "$R" locale-gen >/dev/null 2>&1 || true
echo 'LANG=C.UTF-8' > "$R/etc/default/locale"
chroot "$R" apt-get clean
rm -rf "$R"/var/lib/apt/lists/* "$R"/var/cache/apt/*.bin "$R"/var/log/*.log "$R"/var/log/apt/* "$R"/tmp/* "$R"/var/tmp/*
find "$R/var/log" -type f -exec truncate -s 0 {} +
echo "unify-syslog-server $VERSION, Proxmox LXC template built $(date -u +%Y-%m-%d)" > "$R/etc/unify-syslog-template"

if [[ -n "${KEEP_ROOT:-}" ]]; then
  echo "ROOT=$R"
fi

echo "==> Packing $OUT"
tar --numeric-owner --xattrs --xattrs-include='*' -C "$R" -cf - . | zstd -q -19 -T0 > "$OUT.part"
mv "$OUT.part" "$OUT"
ls -lh "$OUT"
(cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")")
