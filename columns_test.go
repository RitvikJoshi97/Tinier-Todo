package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func jobColumns() []Column {
	return []Column{
		{Name: "Wishlist"}, {Name: "Applied"}, {Name: "Interviewing"},
		{Name: "Offer", Done: true}, {Name: "Rejected", Done: true},
	}
}

func TestBoardsWithoutColumnsGetTheDefaultOnes(t *testing.T) {
	dir := t.TempDir()
	// A boards.json written before columns existed.
	if err := os.WriteFile(filepath.Join(dir, "boards.json"),
		[]byte(`{"boards":[{"id":"default","name":"Default","createdAt":"x"}],"activeBoardId":"default"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	state, _ := s.Boards()
	if got := columnNames(state.Boards[0].Columns); got != "To Do, In Progress, Done" {
		t.Fatalf("columns = %s", got)
	}
	ticket, err := s.CreateTicket("", TicketFields{Name: "Old style", Status: "inprogress"})
	if err != nil || ticket.Status != "inprogress" {
		t.Fatalf("legacy status rejected: %v %+v", err, ticket)
	}
}

func TestCustomColumns(t *testing.T) {
	s := newTestStore(t)
	board, err := s.CreateBoardWithColumns("Job search", jobColumns())
	if err != nil {
		t.Fatal(err)
	}
	if len(board.Columns) != 5 || board.Columns[0].ID == "" || board.Columns[0].ID == board.Columns[1].ID {
		t.Fatalf("columns not given ids: %+v", board.Columns)
	}

	// New tickets go to the first column; a status can be a column name.
	first, _ := s.CreateTicket(board.ID, TicketFields{Name: "Acme"})
	if first.Status != board.Columns[0].ID {
		t.Fatalf("default status = %q, want first column", first.Status)
	}
	applied, err := s.CreateTicket(board.ID, TicketFields{Name: "Globex", Status: "applied"})
	if err != nil || applied.Status != board.Columns[1].ID {
		t.Fatalf("status by name: %v %+v", err, applied)
	}
	if _, err := s.CreateTicket(board.ID, TicketFields{Name: "X", Status: "inprogress"}); err == nil ||
		!strings.Contains(err.Error(), "Wishlist, Applied") {
		t.Fatalf("expected an error listing the columns, got %v", err)
	}
	if moved, err := s.MoveTicket(board.ID, first.ID, "Interviewing"); err != nil || moved.Status != board.Columns[2].ID {
		t.Fatalf("move by name: %v %+v", err, moved)
	}

	for _, bad := range [][]Column{
		nil,
		{{Name: "A"}, {Name: " a "}},
		{{Name: ""}},
		make([]Column, maxColumns+1),
	} {
		if _, err := s.SetBoardColumns(board.ID, bad); err == nil {
			t.Errorf("columns %+v should be rejected", bad)
		}
	}
}

func TestSetBoardColumnsKeepsAndMovesTickets(t *testing.T) {
	s := newTestStore(t)
	board, _ := s.CreateBoardWithColumns("Jobs", jobColumns())
	cols := board.Columns
	_, _ = s.CreateTicket(board.ID, TicketFields{Name: "A", Status: cols[1].ID}) // Applied
	_, _ = s.CreateTicket(board.ID, TicketFields{Name: "B", Status: cols[2].ID}) // Interviewing
	_, _ = s.CreateTicket(board.ID, TicketFields{Name: "C", Status: cols[0].ID}) // Wishlist
	gone, _ := s.CreateTicket(board.ID, TicketFields{Name: "Deleted", Status: cols[2].ID})
	_ = s.DeleteTicket(board.ID, gone.ID)

	// Rename Applied, drop Interviewing and Wishlist, add Ghosted, reorder.
	updated, err := s.SetBoardColumns(board.ID, []Column{
		{ID: cols[1].ID, Name: "Sent"},
		{ID: cols[4].ID, Name: "Rejected", Done: true},
		{Name: "Ghosted"},
		{ID: cols[3].ID, Name: "Offer", Done: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := columnNames(updated.Columns); got != "Sent, Rejected, Ghosted, Offer" {
		t.Fatalf("columns = %s", got)
	}

	tickets, _ := s.Tickets(board.ID)
	status := map[string]string{}
	for _, ticket := range tickets {
		status[ticket.Name] = ticket.Status
	}
	if status["A"] != cols[1].ID {
		t.Errorf("renamed column lost its ticket: %q", status["A"])
	}
	if status["B"] != cols[1].ID {
		t.Errorf("Interviewing's ticket should move to the nearest earlier column (Sent), got %q", status["B"])
	}
	if status["C"] != cols[1].ID {
		t.Errorf("Wishlist had no earlier column, so its ticket goes to the first column, got %q", status["C"])
	}
	deleted, _ := s.DeletedTickets(board.ID)
	if deleted[0].Status != cols[1].ID {
		t.Errorf("deleted tickets should move too, got %q", deleted[0].Status)
	}
}

func TestMoveTicketToBoardMatchesColumns(t *testing.T) {
	s := newTestStore(t)
	jobs, _ := s.CreateBoardWithColumns("Jobs", []Column{{Name: "Applied"}, {Name: "In Progress"}, {Name: "Closed", Done: true}})
	inProgress, _ := s.CreateTicket("", TicketFields{Name: "Started", Status: "inprogress"})
	done, _ := s.CreateTicket("", TicketFields{Name: "Finished", Status: "done"})
	todo, _ := s.CreateTicket("", TicketFields{Name: "Not started"})

	check := func(id int64, want string) {
		t.Helper()
		moved, err := s.MoveTicketToBoard("", id, jobs.ID)
		if err != nil {
			t.Fatal(err)
		}
		if moved.Status != want {
			t.Errorf("%s landed in %q, want %q", moved.Name, moved.Status, want)
		}
	}
	check(inProgress.ID, jobs.Columns[1].ID) // same name
	check(done.ID, jobs.Columns[2].ID)       // finished → first finished column
	check(todo.ID, jobs.Columns[0].ID)       // no match → first column
}

func TestColumnsInExportImportAndReminders(t *testing.T) {
	s := newTestStore(t)
	board, _ := s.CreateBoardWithColumns("Jobs", jobColumns())
	_, _ = s.CreateTicket(board.ID, TicketFields{Name: "Acme", Status: "Applied", Deadline: "2026-11-01"})
	_, _ = s.CreateTicket(board.ID, TicketFields{Name: "Initech", Status: "Offer", Deadline: "2026-11-01"})

	md, err := s.BoardMarkdown(board.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(md, "## Applied\n\n- [ ] **Acme**") || !strings.Contains(md, "## Offer\n\n- [x] **Initech**") {
		t.Fatalf("markdown:\n%s", md)
	}
	csvData, _ := s.BoardCSV(board.ID)
	if !strings.Contains(string(csvData), "Acme,,,Applied,") {
		t.Fatalf("CSV should use column names:\n%s", csvData)
	}

	n, err := s.ImportCSV(board.ID, []byte("name,status\nHooli,interviewing\nPied Piper,completed\nNobody,???\n"))
	if err != nil || n != 3 {
		t.Fatal(n, err)
	}
	tickets, _ := s.Tickets(board.ID)
	got := map[string]string{}
	for _, ticket := range tickets {
		got[ticket.Name] = ticket.Status
	}
	if got["Hooli"] != board.Columns[2].ID || got["Pied Piper"] != board.Columns[3].ID || got["Nobody"] != board.Columns[0].ID {
		t.Fatalf("CSV statuses: %+v", got)
	}

	// Tickets in a finished column get no reminders.
	items, _ := s.pendingReminders(time.Date(2026, 11, 26, 10, 0, 0, 0, time.Local), 9)
	if len(items) != 1 || items[0].Ticket.Name != "Acme" {
		t.Fatalf("reminders: %+v", items)
	}

	// Columns survive a backup round trip.
	backup, _ := s.ExportBackup()
	other := newTestStore(t)
	created, err := other.ImportBackup(backup)
	if err != nil {
		t.Fatal(err)
	}
	var imported Board
	for _, b := range created {
		if b.Name == "Jobs" {
			imported = b
		}
	}
	if columnNames(imported.Columns) != "Wishlist, Applied, Interviewing, Offer, Rejected" || !imported.Columns[3].Done {
		t.Fatalf("imported columns: %+v", imported.Columns)
	}
	importedTickets, _ := other.Tickets(imported.ID)
	for _, ticket := range importedTickets {
		if ticket.Name == "Acme" && ticket.Status != imported.Columns[1].ID {
			t.Fatalf("imported ticket lost its column: %+v", ticket)
		}
	}
}

func TestColumnsFromNames(t *testing.T) {
	current := []Column{{ID: "a", Name: "Applied"}, {ID: "o", Name: "Offer", Done: true}}
	got := columnsFromNames(current, []string{"applied", " New ", "Offer"}, nil)
	if len(got) != 3 || got[0].ID != "a" || got[1].ID != "" || got[1].Name != "New" || !got[2].Done {
		t.Fatalf("got %+v", got)
	}
	got = columnsFromNames(current, []string{"Applied", "Offer"}, []string{"applied"})
	if !got[0].Done || got[1].Done {
		t.Fatalf("done override: %+v", got)
	}
}
