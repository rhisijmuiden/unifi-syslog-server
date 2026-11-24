// SPDX-License-Identifier: AGPL-3.0-or-later

package syslogd

import (
	"context"
	"io"
	"log/slog"
	"net"
	"runtime"
	"testing"
	"time"
)

func freeUDPPort(t *testing.T) string {
	t.Helper()
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, port, _ := net.SplitHostPort(c.LocalAddr().String())
	return port
}

func TestUDPBatchReceive(t *testing.T) {
	for _, tc := range []struct{ listen, dial, want string }{
		{":", "127.0.0.1", "127.0.0.1"},          // dual-stack socket, IPv4 sender
		{"127.0.0.1:", "127.0.0.1", "127.0.0.1"}, // IPv4-only socket
		{":", "[::1]", "::1"},                    // dual-stack socket, IPv6 sender
	} {
		t.Run(tc.listen+tc.dial, func(t *testing.T) {
			port := freeUDPPort(t)
			out := make(chan Message, 1000)
			st := &Stats{}
			s := &Server{UDPAddr: tc.listen + port, ReadBuf: 1 << 20, Out: out, Stats: st, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go s.Run(ctx)
			var c net.Conn
			var err error
			for i := 0; i < 50; i++ {
				if st.UDPBufRequested.Load() > 0 {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
			c, err = net.Dial("udp", tc.dial+":"+port)
			if err != nil {
				t.Skip("no route:", err)
			}
			defer c.Close()
			const n = 200
			for i := 0; i < n; i++ {
				if _, err := c.Write([]byte("<13>hello world")); err != nil {
					t.Skip("send:", err)
				}
			}
			for i := 0; i < n; i++ {
				select {
				case m := <-out:
					if string(m.Data) != "<13>hello world" || m.SourceIP != tc.want {
						t.Fatalf("got %q from %q", m.Data, m.SourceIP)
					}
				case <-time.After(3 * time.Second):
					t.Fatalf("received %d of %d", i, n)
				}
			}
			if got := st.UDPPackets.Load(); got != n {
				t.Fatalf("UDPPackets = %d", got)
			}
			if runtime.GOOS == "linux" && st.UDPBufEffective.Load() <= 0 {
				t.Fatalf("effective buffer unknown")
			}
		})
	}
}
