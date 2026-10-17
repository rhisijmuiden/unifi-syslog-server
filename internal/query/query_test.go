package query

import "testing"

func TestCompile(t *testing.T) {
	cases := []struct {
		q, where string
		n        int
	}{
		{"", "1", 0},
		{"category:firewall action:block", "((category = ? AND action = ?))", 2},
		{`"connection refused"`, "(((positionCaseInsensitiveUTF8(message, ?) > 0 OR positionCaseInsensitiveUTF8(raw, ?) > 0)))", 2},
		{"severity:<=err OR category:ips", "((severity <= ?) OR (category = ?))", 2},
		{"-proto:udp dport:20..25", "((NOT (proto = ?) AND dst_port BETWEEN ? AND ?))", 3},
		{"host:U6*", "((hostname ILIKE ?))", 1},
		{"src:192.168.1.0/24", "((((src_ip != '' AND toUInt32(toIPv4OrZero(src_ip)) BETWEEN ? AND ?))))", 2},
		{"field.UNIFIwifiName:Thuis", "((fields[?] = ?))", 2},
		{`msg:"link down"`, "((positionCaseInsensitiveUTF8(message, ?) > 0))", 1},
	}
	for _, c := range cases {
		f, err := Compile(c.q)
		if err != nil {
			t.Fatalf("%q: %v", c.q, err)
		}
		if f.Where != c.where || len(f.Args) != c.n {
			t.Errorf("%q:\n got %s %v\nwant %s (%d args)", c.q, f.Where, f.Args, c.where, c.n)
		}
	}
	f, _ := Compile("severity:<=err")
	if f.Args[0].(int64) != 3 {
		t.Fatal("severity name")
	}
	f, _ = Compile("src:192.168.1.0/24")
	if f.Args[0].(uint32) != 0xC0A80100 || f.Args[1].(uint32) != 0xC0A801FF {
		t.Fatalf("cidr %v", f.Args)
	}
	if _, err := Compile("bogus:x"); err == nil {
		t.Fatal("expected error")
	}
}
