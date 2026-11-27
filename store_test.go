package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func sampleFields(name string) TicketFields {
	return TicketFields{Name: name, Description: "desc", Project: "proj"}
}

func TestMigratesLegacyFiles(t *testing.T) {
	dir := t.TempDir()
	legacy := `[{"id":1700000000000,"name":"Old","description":"d","project":"p","deadline":"","status":"done","comments":[{"text":"hi","timestamp":"x"}]}]`
	if err := os.WriteFile(filepath.Join(dir, "tickets.json"), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "deleted_tickets.json"), []byte(`[{"id":5,"name":"Gone","description":"d","project":"p","status":"todo","deletedAt":"2026-01-01T00:00:00Z"}]`), 0o644); err != nil {
		t.Fatal(err)
	}

	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	state, err := s.Boards()
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Boards) != 1 || state.Boards[0].ID != defaultBoardID || state.ActiveBoardID != defaultBoardID {
		t.Fatalf("unexpected boards after migration: %+v", state)
	}

	tickets, err := s.Tickets("")
	if err != nil {
		t.Fatal(err)
	}
	if len(tickets) != 1 || tickets[0].Name != "Old" || tickets[0].Status != "done" || len(tickets[0].Comments) != 1 {
		t.Fatalf("legacy tickets not migrated: %+v", tickets)
	}
	deleted, _ := s.DeletedTickets("")
	if len(deleted) != 1 || deleted[0].Name != "Gone" {
		t.Fatalf("legacy deleted tickets not migrated: %+v", deleted)
	}
	if _, err := os.Stat(filepath.Join(dir, "tickets.json")); !os.IsNotExist(err) {
		t.Fatal("legacy tickets.json should have been moved")
	}

	// New ids must be larger than every existing one.
	ticket, err := s.CreateTicket("", sampleFields("New"))
	if err != nil {
		t.Fatal(err)
	}
	if ticket.ID <= 1700000000000 {
		t.Fatalf("new id %d is not above existing ids", ticket.ID)
	}

	// Opening again must not migrate twice or lose anything.
	s2, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	tickets, _ = s2.Tickets("")
	if len(tickets) != 2 {
		t.Fatalf("expected 2 tickets after reopening, got %d", len(tickets))
	}
}

func TestTicketLifecycle(t *testing.T) {
	s := newTestStore(t)

	ticket, err := s.CreateTicket("", sampleFields("A"))
	if err != nil {
		t.Fatal(err)
	}
	if ticket.Status != "todo" || ticket.Comments == nil {
		t.Fatalf("bad defaults: %+v", ticket)
	}

	updated, err := s.UpdateTicket("", ticket.ID, TicketFields{Name: "A2", Description: "d2", Project: "p2", Status: "inprogress", Deadline: "2026-12-01"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "A2" || updated.Status != "inprogress" || updated.Deadline != "2026-12-01" {
		t.Fatalf("update not applied: %+v", updated)
	}

	name := "A3"
	patched, err := s.PatchTicket("", ticket.ID, TicketPatch{Name: &name})
	if err != nil {
		t.Fatal(err)
	}
	if patched.Name != "A3" || patched.Description != "d2" {
		t.Fatalf("patch changed the wrong fields: %+v", patched)
	}

	if _, err := s.MoveTicket("", ticket.ID, "done"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MoveTicket("", ticket.ID, "nope"); err == nil {
		t.Fatal("expected an error for an invalid status")
	}

	commented, err := s.AddComment("", ticket.ID, "looks good")
	if err != nil {
		t.Fatal(err)
	}
	if len(commented.Comments) != 1 || commented.Comments[0].Text != "looks good" {
		t.Fatalf("comment not added: %+v", commented.Comments)
	}

	if err := s.DeleteTicket("", ticket.ID); err != nil {
		t.Fatal(err)
	}
	tickets, _ := s.Tickets("")
	deleted, _ := s.DeletedTickets("")
	if len(tickets) != 0 || len(deleted) != 1 || deleted[0].DeletedAt == "" {
		t.Fatalf("delete failed: active=%d deleted=%+v", len(tickets), deleted)
	}

	restored, err := s.RestoreTicket("", ticket.ID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.DeletedAt != "" || restored.Name != "A3" || len(restored.Comments) != 1 {
		t.Fatalf("restore lost data: %+v", restored)
	}
	deleted, _ = s.DeletedTickets("")
	if len(deleted) != 0 {
		t.Fatal("restored ticket still in deleted list")
	}
}

func TestValidation(t *testing.T) {
	s := newTestStore(t)
	cases := []TicketFields{
		{Name: "", Description: "d", Project: "p"},
		{Name: "   ", Description: "d", Project: "p"},
		{Name: "n", Description: "d", Project: "p", Status: "later"},
		{Name: "n", Description: "d", Project: "p", Deadline: "next week"},
	}
	for _, fields := range cases {
		if _, err := s.CreateTicket("", fields); err == nil {
			t.Errorf("expected validation error for %+v", fields)
		}
	}
	// Only the name is required.
	if _, err := s.CreateTicket("", TicketFields{Name: "Just a title"}); err != nil {
		t.Errorf("a ticket with only a name should be allowed: %v", err)
	}
	if _, err := s.UpdateTicket("", 12345, sampleFields("x")); err == nil {
		t.Error("expected not-found error")
	}
}

func TestConcurrentWritesAreNotLost(t *testing.T) {
	s := newTestStore(t)
	const writers = 40

	var wg sync.WaitGroup
	ids := make(chan int64, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ticket, err := s.CreateTicket("", sampleFields(fmt.Sprintf("t%d", i)))
			if err != nil {
				t.Error(err)
				return
			}
			ids <- ticket.ID
		}(i)
	}
	wg.Wait()
	close(ids)

	seen := map[int64]bool{}
	for id := range ids {
		if seen[id] {
			t.Fatalf("duplicate id %d", id)
		}
		seen[id] = true
	}
	tickets, _ := s.Tickets("")
	if len(tickets) != writers {
		t.Fatalf("expected %d tickets, got %d", writers, len(tickets))
	}
}

func TestCorruptFileFallsBackToBackup(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.CreateTicket("", sampleFields("first")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateTicket("", sampleFields("second")); err != nil {
		t.Fatal(err)
	}

	path := s.ticketsPath(defaultBoardID)
	if err := os.WriteFile(path, []byte(`[{"id": 1, "name": "trunc`), 0o644); err != nil {
		t.Fatal(err)
	}

	tickets, err := s.Tickets("")
	if err != nil {
		t.Fatalf("expected fallback to backup, got %v", err)
	}
	if len(tickets) != 1 || tickets[0].Name != "first" {
		t.Fatalf("expected the backup (one ticket), got %+v", tickets)
	}

	// The next write must not copy the corrupt file over the good backup.
	if _, err := s.CreateTicket("", sampleFields("third")); err != nil {
		t.Fatal(err)
	}
	var backup []Ticket
	data, _ := os.ReadFile(path + ".bak")
	if err := json.Unmarshal(data, &backup); err != nil {
		t.Fatalf("backup was overwritten with invalid data: %v", err)
	}
}

func TestBoards(t *testing.T) {
	s := newTestStore(t)

	work, err := s.CreateBoard("Work")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateBoard("work"); err == nil {
		t.Fatal("expected duplicate-name error")
	}
	if _, err := s.CreateBoard("  "); err == nil {
		t.Fatal("expected empty-name error")
	}

	// Tickets are per board, and boards can be found by name.
	if _, err := s.CreateTicket("Work", sampleFields("w1")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateTicket("", sampleFields("d1")); err != nil {
		t.Fatal(err)
	}
	workTickets, _ := s.Tickets(work.ID)
	defaultTickets, _ := s.Tickets(defaultBoardID)
	if len(workTickets) != 1 || workTickets[0].Name != "w1" || len(defaultTickets) != 1 {
		t.Fatalf("tickets leaked between boards: work=%+v default=%+v", workTickets, defaultTickets)
	}

	if _, err := s.Tickets("../../etc"); err == nil {
		t.Fatal("unknown board references must be rejected")
	}

	if err := s.SetActiveBoard(work.ID); err != nil {
		t.Fatal(err)
	}
	active, _ := s.Tickets("")
	if len(active) != 1 || active[0].Name != "w1" {
		t.Fatal("empty board reference should mean the open board")
	}

	if err := s.RenameBoard(work.ID, "Job"); err != nil {
		t.Fatal(err)
	}
	if err := s.ReorderBoards([]string{work.ID, defaultBoardID}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReorderBoards([]string{work.ID}); err == nil {
		t.Fatal("expected error for an incomplete order")
	}
	state, _ := s.Boards()
	if state.Boards[0].Name != "Job" || state.Boards[1].ID != defaultBoardID {
		t.Fatalf("rename/reorder failed: %+v", state.Boards)
	}

	moved, err := s.MoveTicketToBoard(work.ID, workTickets[0].ID, defaultBoardID)
	if err != nil {
		t.Fatal(err)
	}
	workTickets, _ = s.Tickets(work.ID)
	defaultTickets, _ = s.Tickets(defaultBoardID)
	if len(workTickets) != 0 || len(defaultTickets) != 2 || moved.Name != "w1" {
		t.Fatal("move to board failed")
	}

	if err := s.DeleteBoard(work.ID); err != nil {
		t.Fatal(err)
	}
	state, _ = s.Boards()
	if len(state.Boards) != 1 || state.ActiveBoardID != defaultBoardID {
		t.Fatalf("delete board failed: %+v", state)
	}
	trashed, _ := filepath.Glob(filepath.Join(s.Dir(), "trash", "boards", work.ID+"-*"))
	if len(trashed) != 1 {
		t.Fatal("deleted board folder should be kept in trash")
	}
	if err := s.DeleteBoard(defaultBoardID); err == nil {
		t.Fatal("must not delete the only board")
	}
}

func TestDrafts(t *testing.T) {
	s := newTestStore(t)
	key := draftKey("new", defaultBoardID, 0)

	if draft, err := s.GetDraft(key); err != nil || draft != nil {
		t.Fatalf("expected no draft, got %+v %v", draft, err)
	}
	if err := s.SaveDraft(key, map[string]string{"name": "half"}); err != nil {
		t.Fatal(err)
	}
	draft, err := s.GetDraft(key)
	if err != nil || draft == nil || draft.Fields["name"] != "half" {
		t.Fatalf("draft not saved: %+v %v", draft, err)
	}
	if err := s.SaveDraft("../evil", nil); err == nil {
		t.Fatal("expected invalid key error")
	}

	// Creating a ticket clears the new-ticket draft.
	if _, err := s.CreateTicket("", sampleFields("done")); err != nil {
		t.Fatal(err)
	}
	if draft, _ := s.GetDraft(key); draft != nil {
		t.Fatal("new-ticket draft should be cleared on create")
	}

	// Deleting a ticket clears its edit and comment drafts.
	ticket, _ := s.CreateTicket("", sampleFields("x"))
	_ = s.SaveDraft(draftKey("edit", defaultBoardID, ticket.ID), map[string]string{"name": "y"})
	_ = s.SaveDraft(draftKey("comment", defaultBoardID, ticket.ID), map[string]string{"text": "z"})
	if err := s.DeleteTicket("", ticket.ID); err != nil {
		t.Fatal(err)
	}
	keys, _ := s.DraftKeys()
	if len(keys) != 0 {
		t.Fatalf("drafts left after delete: %v", keys)
	}

	// Deleting a board clears that board's drafts only.
	board, _ := s.CreateBoard("Other")
	_ = s.SaveDraft(draftKey("new", board.ID, 0), map[string]string{"name": "a"})
	_ = s.SaveDraft(draftKey("new", defaultBoardID, 0), map[string]string{"name": "b"})
	if err := s.DeleteBoard(board.ID); err != nil {
		t.Fatal(err)
	}
	keys, _ = s.DraftKeys()
	if len(keys) != 1 || keys[0] != draftKey("new", defaultBoardID, 0) {
		t.Fatalf("wrong drafts after board delete: %v", keys)
	}
}

func TestMCPRejectsBrowserOrigins(t *testing.T) {
	app := &App{store: newTestStore(t)}
	_, handler := newMCPHTTPHandler(app, 3535)

	cases := []struct {
		origin string
		host   string
		want   int
	}{
		{"https://evil.example", "localhost:3535", http.StatusForbidden},
		{"", "evil.example:3535", http.StatusForbidden}, // DNS rebinding
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
		req.Host = c.host
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("origin=%q host=%q: got %d, want %d", c.origin, c.host, rec.Code, c.want)
		}
	}

	if !isLoopbackOrigin("http://localhost:5173") || !isLoopbackOrigin("http://127.0.0.1") || !isLoopbackOrigin("http://[::1]:80") ||
		isLoopbackOrigin("http://localhost.evil.com") || isLoopbackOrigin("null") {
		t.Error("isLoopbackOrigin gives wrong answers")
	}
}

// wails build and wails generate run main(), so creating the app and its menu
// must never touch the data folder.
func TestNewAppDoesNotTouchData(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	app := NewApp()
	_ = app.buildMenu()

	entries, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("NewApp/buildMenu created files in the home folder: %v", entries)
	}
}
