package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func names(tickets []Ticket, status string) []string {
	var out []string
	for _, ticket := range tickets {
		if ticket.Status == status {
			out = append(out, ticket.Name)
		}
	}
	return out
}

func TestPlaceTicketOrdersWithinAndAcrossColumns(t *testing.T) {
	s := newTestStore(t)
	a, _ := s.CreateTicket("", sampleFields("A"))
	b, _ := s.CreateTicket("", sampleFields("B"))
	c, _ := s.CreateTicket("", sampleFields("C"))
	d, _ := s.CreateTicket("", TicketFields{Name: "D", Status: "done"})

	// Reorder within a column: C above A.
	if _, err := s.PlaceTicket("", c.ID, "todo", a.ID); err != nil {
		t.Fatal(err)
	}
	tickets, _ := s.Tickets("")
	if got := strings.Join(names(tickets, "todo"), ","); got != "C,A,B" {
		t.Fatalf("todo order = %s, want C,A,B", got)
	}

	// Move to another column above a given ticket.
	if _, err := s.PlaceTicket("", b.ID, "done", d.ID); err != nil {
		t.Fatal(err)
	}
	tickets, _ = s.Tickets("")
	if got := strings.Join(names(tickets, "done"), ","); got != "B,D" {
		t.Fatalf("done order = %s, want B,D", got)
	}

	// No target: bottom of the column. MoveTicket within the same column
	// keeps the ticket's place.
	if _, err := s.PlaceTicket("", c.ID, "done", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MoveTicket("", d.ID, "done"); err != nil {
		t.Fatal(err)
	}
	tickets, _ = s.Tickets("")
	if got := strings.Join(names(tickets, "done"), ","); got != "B,D,C" {
		t.Fatalf("done order = %s, want B,D,C", got)
	}

	// PlaceTicket with no target moves to the bottom of the same column too.
	if _, err := s.PlaceTicket("", b.ID, "done", 0); err != nil {
		t.Fatal(err)
	}
	tickets, _ = s.Tickets("")
	if got := strings.Join(names(tickets, "done"), ","); got != "D,C,B" {
		t.Fatalf("done order = %s, want D,C,B", got)
	}

	// A target in a different column is an error.
	if _, err := s.PlaceTicket("", a.ID, "inprogress", d.ID); err == nil {
		t.Fatal("expected an error for a target in another column")
	}
}

func TestCommentsEditDeleteAndLegacyIDs(t *testing.T) {
	s := newTestStore(t)
	ticket, _ := s.CreateTicket("", sampleFields("T"))

	// Comments written by older versions have no id.
	path := s.ticketsPath(defaultBoardID)
	data, _ := os.ReadFile(path)
	var raw []map[string]interface{}
	_ = json.Unmarshal(data, &raw)
	raw[0]["comments"] = []map[string]string{{"text": "old one", "timestamp": "x"}, {"text": "old two", "timestamp": "y"}}
	data, _ = json.Marshal(raw)
	_ = os.WriteFile(path, data, 0o644)

	tickets, _ := s.Tickets("")
	if tickets[0].Comments[0].ID != 1 || tickets[0].Comments[1].ID != 2 {
		t.Fatalf("legacy comments should get ids 1 and 2: %+v", tickets[0].Comments)
	}

	added, err := s.AddComment("", ticket.ID, "new")
	if err != nil {
		t.Fatal(err)
	}
	if added.Comments[2].ID != 3 {
		t.Fatalf("new comment id = %d, want 3", added.Comments[2].ID)
	}

	edited, err := s.EditComment("", ticket.ID, 1, "old one, fixed")
	if err != nil {
		t.Fatal(err)
	}
	if edited.Comments[0].Text != "old one, fixed" || edited.Comments[0].EditedAt == "" {
		t.Fatalf("edit not applied: %+v", edited.Comments[0])
	}
	if _, err := s.EditComment("", ticket.ID, 1, "  "); err == nil {
		t.Fatal("empty comment edit should fail")
	}

	deleted, err := s.DeleteComment("", ticket.ID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(deleted.Comments) != 2 || deleted.Comments[1].Text != "new" {
		t.Fatalf("wrong comment deleted: %+v", deleted.Comments)
	}
	if _, err := s.DeleteComment("", ticket.ID, 99); err == nil {
		t.Fatal("deleting a missing comment should fail")
	}

	// Ids survive a reload and stay unique after a delete.
	again, _ := s.AddComment("", ticket.ID, "after delete")
	if again.Comments[2].ID != 4 {
		t.Fatalf("id after delete = %d, want 4", again.Comments[2].ID)
	}
}

func TestBackupRoundTrip(t *testing.T) {
	src := newTestStore(t)
	work, _ := src.CreateBoard("Work")
	_, _ = src.CreateTicket("", TicketFields{Name: "Home task", Deadline: "2026-12-24"})
	wt, _ := src.CreateTicket(work.ID, TicketFields{Name: "Work task", Project: "Ops", Status: "inprogress"})
	_, _ = src.AddComment(work.ID, wt.ID, "a comment")
	gone, _ := src.CreateTicket(work.ID, TicketFields{Name: "Gone"})
	_ = src.DeleteTicket(work.ID, gone.ID)

	backup, err := src.ExportBackup()
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(backup)

	dst := newTestStore(t)
	_, _ = dst.CreateBoard("Work") // name clash
	var parsed Backup
	_ = json.Unmarshal(data, &parsed)
	boards, err := dst.ImportBackup(parsed)
	if err != nil {
		t.Fatal(err)
	}
	if len(boards) != 2 || boards[0].Name != "Default (2)" || boards[1].Name != "Work (2)" {
		t.Fatalf("unexpected imported boards: %+v", boards)
	}
	tickets, _ := dst.Tickets(boards[1].ID)
	if len(tickets) != 1 || tickets[0].Name != "Work task" || tickets[0].Status != "inprogress" || len(tickets[0].Comments) != 1 {
		t.Fatalf("work board not imported intact: %+v", tickets)
	}
	deleted, _ := dst.DeletedTickets(boards[1].ID)
	if len(deleted) != 1 || deleted[0].Name != "Gone" {
		t.Fatalf("deleted tickets not imported: %+v", deleted)
	}

	if _, err := dst.ImportBackup(Backup{Format: "something-else", Boards: parsed.Boards}); err == nil {
		t.Fatal("a file that isn't a backup must be rejected")
	}
}

func TestMarkdownAndCSVExport(t *testing.T) {
	s := newTestStore(t)
	_, _ = s.CreateTicket("", TicketFields{Name: "Write docs", Description: "Line one\nLine two", Project: "Docs", Deadline: "2026-12-01"})
	_, _ = s.CreateTicket("", TicketFields{Name: "Ship it", Status: "done", Link: "https://example.com"})

	md, err := s.BoardMarkdown("")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"# Default", "## To Do", "- [ ] **Write docs** — Docs · due 2026-12-01", "  Line two",
		"## In Progress", "_No tickets._", "- [x] **Ship it**", "<https://example.com>",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown is missing %q:\n%s", want, md)
		}
	}

	csvData, err := s.BoardCSV("")
	if err != nil {
		t.Fatal(err)
	}
	// A UTF-8 byte-order mark and CRLF line ends, as Excel expects.
	if !strings.HasPrefix(string(csvData), "\xef\xbb\xbfname,description,project,status,deadline,link,comments\r\n") {
		t.Fatalf("unexpected CSV header: %s", csvData)
	}

	// The exported CSV imports back into a new board.
	board, _ := s.CreateBoard("Copy")
	count, err := s.ImportCSV(board.ID, csvData)
	if err != nil || count != 2 {
		t.Fatalf("re-import: count=%d err=%v", count, err)
	}
	copied, _ := s.Tickets(board.ID)
	if copied[0].Description != "Line one\nLine two" || copied[1].Status != "done" {
		t.Fatalf("CSV round trip lost data: %+v", copied)
	}
}

func TestImportCSVFromASpreadsheet(t *testing.T) {
	s := newTestStore(t)
	data := "\xef\xbb\xbfTitle,Status,Deadline,Notes\nBuy milk,In Progress,2026/12/03,ignored\n,todo,,\nCall bank,Completed,not a date,\n"
	count, err := s.ImportCSV("", []byte(data))
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("count = %d, want 2 (blank names skipped)", count)
	}
	tickets, _ := s.Tickets("")
	if tickets[0].Status != "inprogress" || tickets[0].Deadline != "2026-12-03" {
		t.Fatalf("first row parsed wrong: %+v", tickets[0])
	}
	if tickets[1].Status != "done" || tickets[1].Deadline != "" {
		t.Fatalf("second row parsed wrong: %+v", tickets[1])
	}

	if _, err := s.ImportCSV("", []byte("project,status\nx,todo\n")); err == nil {
		t.Fatal("a CSV without a name column must be rejected")
	}
}

func TestReminders(t *testing.T) {
	s := newTestStore(t)
	work, _ := s.CreateBoard("Work")
	_, _ = s.CreateTicket("", TicketFields{Name: "Overdue", Deadline: "2026-11-20"})
	_, _ = s.CreateTicket("", TicketFields{Name: "Today", Deadline: "2026-11-26"})
	_, _ = s.CreateTicket("", TicketFields{Name: "Tomorrow", Deadline: "2026-11-27"})
	_, _ = s.CreateTicket("", TicketFields{Name: "Done already", Deadline: "2026-11-01", Status: "done"})
	_, _ = s.CreateTicket(work.ID, TicketFields{Name: "Work today", Deadline: "2026-11-26"})

	morning := time.Date(2026, 11, 26, 8, 0, 0, 0, time.Local)
	if items, _ := s.pendingReminders(morning, 9); len(items) != 0 {
		t.Fatal("nothing should be due before the reminder hour")
	}

	nine := time.Date(2026, 11, 26, 9, 5, 0, 0, time.Local)
	items, err := s.pendingReminders(nine, 9)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 || items[0].Ticket.Name != "Overdue" || !items[0].Overdue {
		t.Fatalf("unexpected due tickets: %+v", items)
	}

	title, message := reminderMessage(items, true)
	if title != "3 tickets need attention" || !strings.Contains(message, "1 overdue, 2 due today") || !strings.Contains(message, "Work today (Work)") {
		t.Fatalf("unexpected message: %q / %q", title, message)
	}
	title, message = reminderMessage(items[:1], false)
	if title != "Overdue since 2026-11-20" || message != "Overdue" {
		t.Fatalf("unexpected single message: %q / %q", title, message)
	}

	// Once reminded, not again the same day; again the next day.
	if err := s.markReminded(items, nine); err != nil {
		t.Fatal(err)
	}
	if again, _ := s.pendingReminders(nine.Add(time.Hour), 9); len(again) != 0 {
		t.Fatalf("reminded twice in one day: %+v", again)
	}
	nextDay := nine.AddDate(0, 0, 1)
	if next, _ := s.pendingReminders(nextDay, 9); len(next) != 4 {
		t.Fatalf("next day should include the 3 again plus Tomorrow, got %d", len(next))
	}
}

func TestCheckRemindersRespectsSettings(t *testing.T) {
	s := newTestStore(t)
	_, _ = s.CreateTicket("", TicketFields{Name: "Due", Deadline: "2026-11-26"})
	app := &App{store: s}

	var sent []string
	saved := notify
	notify = func(title, message string) error { sent = append(sent, title+": "+message); return nil }
	defer func() { notify = saved }()

	now := time.Date(2026, 11, 26, 10, 0, 0, 0, time.Local)
	_, _ = s.SaveSettings(Settings{Reminders: ReminderSettings{Enabled: false, Hour: 9}})
	app.checkReminders(now)
	if len(sent) != 0 {
		t.Fatal("reminders are off")
	}

	_, _ = s.SaveSettings(Settings{Reminders: ReminderSettings{Enabled: true, Hour: 9}})
	app.checkReminders(now)
	app.checkReminders(now.Add(10 * time.Minute))
	if len(sent) != 1 || sent[0] != "Due today: Due" {
		t.Fatalf("expected exactly one reminder, got %v", sent)
	}

	if got, _ := s.SaveSettings(Settings{Reminders: ReminderSettings{Enabled: true, Hour: 42}}); got.Reminders.Hour != 9 {
		t.Fatalf("invalid hour should reset to 9, got %d", got.Reminders.Hour)
	}
}

func TestWindowStateIsReadOnlyAtStartup(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	state := loadWindowState()
	if state.Width != defaultWindowWidth || state.Height != defaultWindowHeight {
		t.Fatalf("unexpected defaults: %+v", state)
	}
	if entries, _ := os.ReadDir(home); len(entries) != 0 {
		t.Fatalf("loadWindowState created files: %v", entries)
	}

	// A saved state too small to use falls back to the defaults.
	_ = os.MkdirAll(home+"/.tinier-todo", 0o755)
	_ = os.WriteFile(home+"/.tinier-todo/window.json", []byte(`{"width":100,"height":50}`), 0o644)
	if state := loadWindowState(); state.Width != defaultWindowWidth {
		t.Fatalf("tiny saved size should be ignored: %+v", state)
	}
	_ = os.WriteFile(home+"/.tinier-todo/window.json", []byte(`{"width":1400,"height":900,"x":40,"y":60,"hasPosition":true}`), 0o644)
	if state := loadWindowState(); state.Width != 1400 || state.X != 40 || !state.HasPosition {
		t.Fatalf("saved state not loaded: %+v", state)
	}
}
