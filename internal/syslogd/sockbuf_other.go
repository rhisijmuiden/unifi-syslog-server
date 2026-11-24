// SPDX-License-Identifier: AGPL-3.0-or-later

//go:build !linux

package syslogd

import "net"

func setRecvBuffer(uc *net.UDPConn, want int) (int, bool) {
	uc.SetReadBuffer(want)
	return 0, false
}

// RmemMax is only known on Linux.
func RmemMax() int { return 0 }
