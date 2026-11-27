package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
)

func TestCleanLink(t *testing.T) {
	ok := map[string]string{
		"":                           "",
		" https://example.com/x ":    "https://example.com/x",
		"http://localhost:8080":      "http://localhost:8080",
		"example.com/page":           "https://example.com/page",
		"localhost:3000/a":           "https://localhost:3000/a",
		"mailto:someone@example.com": "mailto:someone@example.com",
		"HTTPS://Example.com":        "HTTPS://Example.com",
	}
	for in, want := range ok {
		got, err := cleanLink(in)
		if err != nil || got != want {
			t.Errorf("cleanLink(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{
		"file:///Applications/Calculator.app",
		"javascript:alert(1)",
		"vscode://extension/evil",
		"smb://server/share",
		"ssh://host",
		"https://",
		"mailto:",
	} {
		if got, err := cleanLink(bad); err == nil {
			t.Errorf("cleanLink(%q) = %q, should be rejected", bad, got)
		}
	}
}

func TestUnsafeLinksAreRejectedOrDropped(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateTicket("", TicketFields{Name: "x", Link: "file:///etc/passwd"}); err == nil {
		t.Fatal("a file:// link should be rejected")
	}
	ticket, err := s.CreateTicket("", TicketFields{Name: "y", Link: "example.com"})
	if err != nil || ticket.Link != "https://example.com" {
		t.Fatalf("bare domain: %v %+v", err, ticket)
	}
	if _, err := s.ImportCSV("", []byte("name,link\nEvil,file:///x\n")); err == nil {
		t.Fatal("CSV with an unsafe link should be rejected")
	}

	// A backup is imported, but its unsafe links are dropped.
	backup := Backup{Format: backupFormat, Version: 1, Boards: []BackupBoard{{Name: "From backup", Tickets: []Ticket{
		{Name: "Bad", Link: "vscode://evil"}, {Name: "Good", Link: "https://example.com"},
	}}}}
	created, err := s.ImportBackup(backup)
	if err != nil {
		t.Fatal(err)
	}
	tickets, _ := s.Tickets(created[0].ID)
	links := map[string]string{}
	for _, ticket := range tickets {
		links[ticket.Name] = ticket.Link
	}
	if links["Bad"] != "" || links["Good"] != "https://example.com" {
		t.Fatalf("links after import: %+v", links)
	}
}

func TestDataFolderIsPrivate(t *testing.T) {
	if goruntime.GOOS == "windows" {
		t.Skip("permissions work differently on Windows")
	}
	dir := filepath.Join(t.TempDir(), "data")
	// The layout an earlier version left behind: readable by everyone.
	if err := os.MkdirAll(filepath.Join(dir, "boards", "default"), 0o755); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, "boards", "default", "tickets.json")
	if err := os.WriteFile(old, []byte("[]"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chmod(dir, 0o755)

	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateBoard("New"); err != nil {
		t.Fatal(err)
	}
	_, _ = s.CreateTicket("", TicketFields{Name: "secret"})

	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		info, _ := d.Info()
		if info.Mode().Perm()&0o077 != 0 {
			t.Errorf("%s is %v, want private", path, info.Mode().Perm())
		}
		return nil
	})
}

func TestMCPNeedsToken(t *testing.T) {
	app := &App{store: newTestStore(t), mcpSettings: MCPSettings{Port: 3535, Token: "the-secret-token-123"}}
	_, handler := newMCPHTTPHandler(app, 3535)
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`

	cases := []struct {
		name   string
		header string
		query  string
		want   int
	}{
		{"no token", "", "", http.StatusUnauthorized},
		{"wrong token", "Bearer nope", "", http.StatusUnauthorized},
		{"header", "Bearer the-secret-token-123", "", http.StatusOK},
		{"lowercase bearer", "bearer the-secret-token-123", "", http.StatusOK},
		{"query", "", "?token=the-secret-token-123", http.StatusOK},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodPost, "/mcp"+c.query, strings.NewReader(body))
		req.Host = "localhost:3535"
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if c.header != "" {
			req.Header.Set("Authorization", c.header)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%s: got %d, want %d (%s)", c.name, rec.Code, c.want, rec.Body.String())
		}
	}
}

func TestMCPSettingsGetAToken(t *testing.T) {
	settings := sanitizeMCPSettings(MCPSettings{Enabled: true, Port: 3535})
	if len(settings.Token) < 30 {
		t.Fatalf("token = %q", settings.Token)
	}
	if again := sanitizeMCPSettings(settings); again.Token != settings.Token {
		t.Fatal("an existing token should be kept")
	}
	if defaultMCPSettings().Enabled {
		t.Fatal("MCP should start switched off")
	}
	response := buildMCPSettingsResponse(settings)
	if !strings.Contains(response["snippet"].(string), "Bearer "+settings.Token) ||
		!strings.Contains(response["command"].(string), "--header \"Authorization: Bearer "+settings.Token+"\"") {
		t.Fatalf("response: %+v", response)
	}
}

func TestFileVaultState(t *testing.T) {
	for out, want := range map[string]string{
		"FileVault is On.\n":  "on",
		"FileVault is Off.\n": "off",
		"FileVault is On.\nDeferred enablement appears to be active": "on",
		"": "unknown",
	} {
		if got := fileVaultState(out); got != want {
			t.Errorf("fileVaultState(%q) = %q, want %q", out, got, want)
		}
	}
}

func TestCSVFromWindowsExcel(t *testing.T) {
	s := newTestStore(t)
	// Windows-1252 ("é" is 0xE9, "€" 0x80, "’" 0x92), ';'-separated, CRLF.
	data := []byte("name;project;deadline\r\nCaf\xe9 \x80 budget;Men\x92s;2026-12-01\r\n")
	n, err := s.ImportCSV("", data)
	if err != nil || n != 1 {
		t.Fatal(n, err)
	}
	tickets, _ := s.Tickets("")
	if tickets[0].Name != "Café € budget" || tickets[0].Project != "Men’s" || tickets[0].Deadline != "2026-12-01" {
		t.Fatalf("got %+v", tickets[0])
	}
}

func TestBitLockerState(t *testing.T) {
	for value, want := range map[string]string{"1\r\n": "on", "3": "on", "6": "on", "2": "off", "8": "off", "5": "off", "": "unknown", "\r\n": "unknown"} {
		if got := bitLockerState(value); got != want {
			t.Errorf("bitLockerState(%q) = %q, want %q", value, got, want)
		}
	}
}

func TestLinuxBlockDeviceEncryption(t *testing.T) {
	root := t.TempDir()
	mk := func(path, uuid string) string {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Join(full, "slaves"), 0o700); err != nil {
			t.Fatal(err)
		}
		if uuid != "" {
			_ = os.MkdirAll(filepath.Join(full, "dm"), 0o700)
			_ = os.WriteFile(filepath.Join(full, "dm", "uuid"), []byte(uuid+"\n"), 0o600)
		}
		return full
	}
	// LVM on LUKS: home is on an LVM volume whose only "slave" is the LUKS device.
	lvm := mk("lvm", "LVM-abc")
	mk("lvm/slaves/dm-0", "CRYPT-LUKS2-1234-luks")
	if got := blockDeviceEncryption(lvm, 0); got != "on" {
		t.Errorf("LVM on LUKS = %q", got)
	}
	plain := mk("sda2", "")
	if got := blockDeviceEncryption(plain, 0); got != "off" {
		t.Errorf("plain partition = %q", got)
	}
	if got := blockDeviceEncryption(filepath.Join(root, "missing"), 0); got != "unknown" {
		t.Errorf("missing device = %q", got)
	}
}

func TestSavedWindowPositionMustFitTheScreen(t *testing.T) {
	window := WindowState{Width: 1100, Height: 760}
	at := func(x, y int) WindowState { w := window; w.X, w.Y = x, y; return w }
	if !positionFits(at(200, 100), 1440, 900) {
		t.Error("an on-screen position should be kept")
	}
	for _, pos := range []WindowState{at(2500, 100), at(-1500, 100), at(200, -400), at(200, 880)} {
		if positionFits(pos, 1440, 900) {
			t.Errorf("(%d, %d) is off a 1440×900 screen", pos.X, pos.Y)
		}
	}
	if !positionFits(at(5000, 5000), 0, 0) {
		t.Error("with no screen size known, keep the position")
	}
}
