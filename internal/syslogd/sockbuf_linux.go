// SPDX-License-Identifier: AGPL-3.0-or-later

//go:build linux

package syslogd

import (
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// setRecvBuffer asks for a UDP receive buffer of want bytes. SO_RCVBUF is
// silently capped at net.core.rmem_max, so SO_RCVBUFFORCE is tried first: it
// ignores the cap but needs CAP_NET_ADMIN in the host's user namespace, which
// a service in an unprivileged container never has. It returns the size the
// kernel really uses (getsockopt reports twice the usable size) and whether
// the forced call worked.
func setRecvBuffer(uc *net.UDPConn, want int) (effective int, forced bool) {
	rc, err := uc.SyscallConn()
	if err != nil {
		return 0, false
	}
	rc.Control(func(fd uintptr) {
		if syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUFFORCE, want) == nil {
			forced = true
		} else {
			syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, want)
		}
		if v, err := syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF); err == nil {
			effective = v / 2
		}
	})
	return effective, forced
}

// RmemMax returns net.core.rmem_max: the largest receive buffer a socket
// may ask for without CAP_NET_ADMIN. In a container it is the host's value.
func RmemMax() int {
	b, err := os.ReadFile("/proc/sys/net/core/rmem_max")
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}
