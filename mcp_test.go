package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// callTool calls an MCP tool the way a client would and returns its text and
// whether it reported an error.
func callTool(t *testing.T, app *App, name string, args map[string]any) (string, bool) {
	t.Helper()
	server := newMCPServer(app)
	request, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	})
	response := server.HandleMessage(context.Background(), request)
	data, _ := json.Marshal(response)
	var raw struct {
		Result struct {
			Content []struct{ Text string } `json:"content"`
			IsError bool                    `json:"isError"`
		} `json:"result"`
		Error *struct{ Message string } `json:"error"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if raw.Error != nil {
		t.Fatalf("%s: %s", name, raw.Error.Message)
	}
	texts := []string{}
	for _, content := range raw.Result.Content {
		texts = append(texts, content.Text)
	}
	return strings.Join(texts, "\n"), raw.Result.IsError
}

func TestMCPSearchAndGetTicket(t *testing.T) {
	app := &App{store: newTestStore(t)}
	store := app.store
	today := time.Now().Format("2006-01-02")
	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02")

	jobs, _ := store.CreateBoardWithColumns("Jobs", jobColumns())
	_, _ = store.CreateTicket(jobs.ID, TicketFields{Name: "Acme backend role", Status: "Applied", Deadline: yesterday})
	_, _ = store.CreateTicket(jobs.ID, TicketFields{Name: "Initech", Status: "Offer", Deadline: yesterday})
	home, _ := store.CreateTicket("", TicketFields{Name: "Pay rent", Project: "Home", Deadline: today})
	_, _ = store.AddComment("", home.ID, "Ask about the backend of the boiler")

	// Text search across every board, including comments.
	out, isErr := callTool(t, app, "search_tickets", map[string]any{"query": "BACKEND"})
	if isErr || !strings.Contains(out, "Acme backend role") || !strings.Contains(out, "Pay rent") {
		t.Fatalf("search: %s", out)
	}
	if !strings.Contains(out, `"board": "Jobs"`) || !strings.Contains(out, `"column": "Applied"`) {
		t.Fatalf("results should name the board and column: %s", out)
	}

	// Overdue leaves out finished columns; include_done doesn't bring back
	// overdue ones, since a finished ticket is never overdue.
	out, _ = callTool(t, app, "search_tickets", map[string]any{"due": "overdue"})
	if !strings.Contains(out, "Acme") || strings.Contains(out, "Initech") || strings.Contains(out, "Pay rent") {
		t.Fatalf("overdue: %s", out)
	}
	out, _ = callTool(t, app, "search_tickets", map[string]any{"due": "today"})
	if !strings.Contains(out, "Pay rent") || strings.Contains(out, "Acme") {
		t.Fatalf("today: %s", out)
	}
	out, _ = callTool(t, app, "search_tickets", map[string]any{"status": "offer"})
	if out != "No tickets match." {
		t.Fatalf("finished tickets should be left out by default: %s", out)
	}
	out, _ = callTool(t, app, "search_tickets", map[string]any{"status": "offer", "include_done": true})
	if !strings.Contains(out, "Initech") {
		t.Fatalf("include_done: %s", out)
	}
	if out, isErr = callTool(t, app, "search_tickets", map[string]any{"status": "Nope"}); !isErr {
		t.Fatalf("unknown column should be an error: %s", out)
	}
	if _, isErr = callTool(t, app, "search_tickets", map[string]any{"due": "soon"}); !isErr {
		t.Fatal("unknown due filter should be an error")
	}
	out, _ = callTool(t, app, "search_tickets", map[string]any{"limit": 1})
	if !strings.HasPrefix(out, "2 tickets match; showing the first 1.") {
		t.Fatalf("limit: %s", out)
	}

	// list_tickets stays on one board and shows column names.
	out, _ = callTool(t, app, "list_tickets", map[string]any{"board": "jobs", "due": "week"})
	if !strings.Contains(out, "Acme") || strings.Contains(out, "Pay rent") || strings.Contains(out, "Initech") {
		t.Fatalf("list_tickets due=week: %s", out)
	}

	out, isErr = callTool(t, app, "get_ticket", map[string]any{"id": home.ID})
	if isErr || !strings.Contains(out, "boiler") || !strings.Contains(out, `"column": "To Do"`) {
		t.Fatalf("get_ticket: %s", out)
	}
	if _, isErr = callTool(t, app, "get_ticket", map[string]any{"id": 999}); !isErr {
		t.Fatal("missing ticket should be an error")
	}
}

func TestMCPEditTicketStatusAndBoardTools(t *testing.T) {
	app := &App{store: newTestStore(t)}
	store := app.store
	jobs, _ := store.CreateBoardWithColumns("Jobs", jobColumns())
	a, _ := store.CreateTicket(jobs.ID, TicketFields{Name: "A", Status: "Applied"})
	_, _ = store.CreateTicket(jobs.ID, TicketFields{Name: "B", Status: "Interviewing"})
	c, _ := store.CreateTicket(jobs.ID, TicketFields{Name: "C", Status: "Wishlist"})

	// A bad status changes nothing, not even the other fields.
	if _, isErr := callTool(t, app, "edit_ticket", map[string]any{"board": "Jobs", "id": c.ID, "name": "Changed", "status": "Nope"}); !isErr {
		t.Fatal("bad status should be an error")
	}
	got, _ := store.GetTicket("Jobs", c.ID)
	if got.Name != "C" {
		t.Fatalf("ticket changed despite the error: %+v", got)
	}

	out, isErr := callTool(t, app, "edit_ticket", map[string]any{"board": "Jobs", "id": c.ID, "name": "C2", "status": "interviewing"})
	if isErr {
		t.Fatal(out)
	}
	tickets, _ := store.Tickets(jobs.ID)
	if last := tickets[len(tickets)-1]; last.ID != c.ID || last.Name != "C2" || last.Status != jobs.Columns[2].ID {
		t.Fatalf("edited ticket should be at the bottom of Interviewing: %+v", tickets)
	}

	out, _ = callTool(t, app, "move_ticket", map[string]any{"board": "Jobs", "id": a.ID, "status": "offer"})
	if out != fmt.Sprintf("Ticket %d moved to 'Offer'.", a.ID) {
		t.Fatalf("move_ticket should name the column: %s", out)
	}

	if out, isErr = callTool(t, app, "rename_board", map[string]any{"board": "jobs", "name": "Job hunt"}); isErr {
		t.Fatal(out)
	}
	if _, err := store.ResolveBoard("Job hunt"); err != nil {
		t.Fatal(err)
	}
	if out, isErr = callTool(t, app, "open_board", map[string]any{"board": "Job hunt"}); isErr {
		t.Fatal(out)
	}
	state, _ := store.Boards()
	if state.ActiveBoardID != jobs.ID {
		t.Fatalf("open_board didn't switch: %s", state.ActiveBoardID)
	}
	out, _ = callTool(t, app, "board_markdown", nil)
	if !strings.Contains(out, "## Interviewing") || !strings.Contains(out, "C2") {
		t.Fatalf("board_markdown: %s", out)
	}

	if _, isErr = callTool(t, app, "delete_board", map[string]any{}); !isErr {
		t.Fatal("delete_board without a board should be an error")
	}
	if out, isErr = callTool(t, app, "delete_board", map[string]any{"board": "Job hunt"}); isErr {
		t.Fatal(out)
	}
	state, _ = store.Boards()
	if len(state.Boards) != 1 {
		t.Fatalf("boards after delete: %+v", state.Boards)
	}
}

func TestMCPToolAnnotations(t *testing.T) {
	server := newMCPServer(&App{store: newTestStore(t)})
	request, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
	data, _ := json.Marshal(server.HandleMessage(context.Background(), request))
	var list struct {
		Result struct{ Tools []mcp.Tool } `json:"result"`
	}
	if err := json.Unmarshal(data, &list); err != nil {
		t.Fatal(err)
	}
	hints := map[string]mcp.ToolAnnotation{}
	for _, tool := range list.Result.Tools {
		hints[tool.Name] = tool.Annotations
	}
	for name, readOnly := range map[string]bool{"search_tickets": true, "get_ticket": true, "list_boards": true, "create_ticket": false} {
		if got := hints[name].ReadOnlyHint; got == nil || *got != readOnly {
			t.Errorf("%s readOnly = %v, want %v", name, got, readOnly)
		}
	}
	for name, destructive := range map[string]bool{"delete_board": true, "delete_ticket": true, "edit_ticket": false} {
		if got := hints[name].DestructiveHint; got == nil || *got != destructive {
			t.Errorf("%s destructive = %v, want %v", name, got, destructive)
		}
	}
	if len(hints) != 20 {
		t.Errorf("got %d tools", len(hints))
	}
}
