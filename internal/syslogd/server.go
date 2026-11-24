// SPDX-License-Identifier: AGPL-3.0-or-later

// Package syslogd receives syslog over UDP and TCP (RFC 6587 octet counting
// and newline framing).
package syslogd

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"strconv"
	"sync/atomic"
	"time"

	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

type Message struct {
	Data     []byte
	SourceIP string
	Received time.Time
	// Probe and Site are set for messages relayed by a remote probe.
	Probe string
	Site  string
}

type Stats struct {
	UDPPackets atomic.Uint64
	TCPMsgs    atomic.Uint64
	TCPConns   atomic.Int64
	Dropped    atomic.Uint64
	// UDPBufRequested is the receive buffer the server asked for and
	// UDPBufEffective what the kernel granted (0 when unknown).
	UDPBufRequested atomic.Int64
	UDPBufEffective atomic.Int64
	// UDPBufForced is set when SO_RCVBUFFORCE bypassed net.core.rmem_max.
	UDPBufForced atomic.Bool
}

type Server struct {
	UDPAddr string
	TCPAddr string
	ReadBuf int
	Out     chan<- Message
	Stats   *Stats
	Log     *slog.Logger
	// Filter is the optional source allowlist.
	Filter *Filter
}

const maxMsg = 64 * 1024

// batchSize is how many datagrams one recvmmsg call can return.
const batchSize = 32

func (s *Server) Run(ctx context.Context) error {
	errc := make(chan error, 2)
	if s.UDPAddr != "" {
		pc, err := net.ListenPacket("udp", s.UDPAddr)
		if err != nil {
			return err
		}
		uc := pc.(*net.UDPConn)
		if s.ReadBuf > 0 {
			eff, forced := setRecvBuffer(uc, s.ReadBuf)
			s.Stats.UDPBufRequested.Store(int64(s.ReadBuf))
			s.Stats.UDPBufEffective.Store(int64(eff))
			s.Stats.UDPBufForced.Store(forced)
			if eff > 0 && eff < s.ReadBuf {
				s.Log.Warn("UDP receive buffer is smaller than configured; raise net.core.rmem_max on the host (the Proxmox host for an LXC container)",
					"requested", s.ReadBuf, "effective", eff, "rmem_max", RmemMax())
			}
		}
		s.Log.Info("syslog UDP listening", "addr", s.UDPAddr, "receive_buffer", s.Stats.UDPBufEffective.Load())
		go func() { <-ctx.Done(); pc.Close() }()
		go func() { errc <- s.serveUDP(uc) }()
	}
	if s.TCPAddr != "" {
		ln, err := net.Listen("tcp", s.TCPAddr)
		if err != nil {
			return err
		}
		s.Log.Info("syslog TCP listening", "addr", s.TCPAddr)
		go func() { <-ctx.Done(); ln.Close() }()
		go func() { errc <- s.serveTCP(ctx, ln) }()
	}
	select {
	case <-ctx.Done():
		return nil
	case err := <-errc:
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
}

func (s *Server) emit(data []byte, ip string) {
	msg := Message{Data: data, SourceIP: ip, Received: time.Now()}
	select {
	case s.Out <- msg:
	default:
		s.Stats.Dropped.Add(1)
	}
}

// serveUDP drains the socket in batches (recvmmsg on Linux) so a burst
// costs one system call per batch instead of one per packet.
func (s *Server) serveUDP(uc *net.UDPConn) error {
	var br interface {
		ReadBatch([]ipv4.Message, int) (int, error)
	}
	if a, ok := uc.LocalAddr().(*net.UDPAddr); ok && a.IP.To4() != nil {
		br = ipv4.NewPacketConn(uc)
	} else {
		br = ipv6.NewPacketConn(uc)
	}
	ms := make([]ipv4.Message, batchSize)
	for i := range ms {
		ms[i].Buffers = [][]byte{make([]byte, maxMsg)}
	}
	for {
		n, err := br.ReadBatch(ms, 0)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			s.Log.Warn("udp read", "err", err)
			time.Sleep(10 * time.Millisecond)
			continue
		}
		s.Stats.UDPPackets.Add(uint64(n))
		for i := range ms[:n] {
			m := &ms[i]
			if m.Addr == nil {
				continue
			}
			ip := addrIP(m.Addr)
			if !s.Filter.Allow(ip, "udp") {
				continue
			}
			data := make([]byte, m.N)
			copy(data, m.Buffers[0][:m.N])
			s.emit(data, ip)
		}
	}
}

func (s *Server) serveTCP(ctx context.Context, ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			s.Log.Warn("tcp accept", "err", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		if !s.Filter.Allow(addrIP(c.RemoteAddr()), "tcp") {
			c.Close()
			continue
		}
		go s.handleTCP(ctx, c)
	}
}

func (s *Server) handleTCP(ctx context.Context, c net.Conn) {
	s.Stats.TCPConns.Add(1)
	defer s.Stats.TCPConns.Add(-1)
	defer c.Close()
	ip := addrIP(c.RemoteAddr())
	r := bufio.NewReaderSize(c, 64*1024)
	for ctx.Err() == nil {
		c.SetReadDeadline(time.Now().Add(15 * time.Minute))
		msg, err := readFrame(r)
		if len(msg) > 0 {
			s.Stats.TCPMsgs.Add(1)
			s.emit(msg, ip)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				s.Log.Debug("tcp read", "peer", ip, "err", err)
			}
			return
		}
	}
}

// readFrame reads one message using octet counting ("123 <PRI>...") when
// the frame starts with a digit, else LF-terminated framing.
func readFrame(r *bufio.Reader) ([]byte, error) {
	b, err := r.Peek(1)
	if err != nil {
		return nil, err
	}
	if b[0] >= '1' && b[0] <= '9' {
		lenStr, err := r.ReadString(' ')
		if err != nil {
			return nil, err
		}
		n, err := strconv.Atoi(lenStr[:len(lenStr)-1])
		if err != nil || n <= 0 || n > maxMsg {
			// Not octet counted after all: treat the digits as message start.
			rest, err2 := r.ReadBytes('\n')
			return append([]byte(lenStr), rest...), err2
		}
		buf := make([]byte, n)
		_, err = io.ReadFull(r, buf)
		return buf, err
	}
	line, err := r.ReadBytes('\n')
	if len(line) > maxMsg {
		line = line[:maxMsg]
	}
	return line, err
}

func addrIP(a net.Addr) string {
	switch v := a.(type) {
	case *net.UDPAddr:
		return v.IP.String()
	case *net.TCPAddr:
		return v.IP.String()
	}
	h, _, _ := net.SplitHostPort(a.String())
	return h
}
