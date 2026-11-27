package main

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// TicketView is a ticket with the names of its board and column, as the MCP
// tools return it.
type TicketView struct {
	Ticket
	Board   string `json:"board"`
	BoardID string `json:"boardId"`
	Column  string `json:"column"`
	Done    bool   `json:"done,omitempty"`
}

// TicketQuery selects tickets across one or more boards.
type TicketQuery struct {
	// Board is a board name or id; "" means the open board and "*" every board.
	Board string
	// Text must all appear (ignoring case) in the title, description,
	// project or comments. Words are matched separately.
	Text string
	// Status is a column id or name.
	Status  string
	Project string
	// Due is "", "overdue", "today", "week" (due within 7 days, including open
	// overdue tickets) or "none" (no deadline), as in the app's filter.
	Due string
	// ExcludeDone leaves out tickets in finished columns.
	ExcludeDone bool
}

var dueFilters = []string{"overdue", "today", "week", "none"}

// daysUntil is the number of days from today to a YYYY-MM-DD deadline.
func daysUntil(deadline string, now time.Time) (int, bool) {
	due, err := time.Parse("2006-01-02", deadline)
	if err != nil {
		return 0, false
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	return int(due.Sub(today).Hours() / 24), true
}

// matchesDue mirrors matchesFilters in frontend/src/lib/search.ts.
func matchesDue(ticket Ticket, due string, done bool, now time.Time) bool {
	days, hasDeadline := daysUntil(ticket.Deadline, now)
	switch due {
	case "":
		return true
	case "none":
		return !hasDeadline
	case "overdue":
		return hasDeadline && days < 0 && !done
	case "today":
		return hasDeadline && days == 0
	case "week":
		return hasDeadline && days <= 7 && (days >= 0 || !done)
	}
	return false
}

func matchesText(ticket Ticket, words []string) bool {
	parts := []string{ticket.Name, ticket.Description, ticket.Project}
	for _, comment := range ticket.Comments {
		parts = append(parts, comment.Text)
	}
	haystack := strings.ToLower(strings.Join(parts, "\n"))
	for _, word := range words {
		if !strings.Contains(haystack, word) {
			return false
		}
	}
	return true
}

func viewOf(ticket Ticket, board Board, columns []Column) TicketView {
	view := TicketView{Ticket: ticket, Board: board.Name, BoardID: board.ID}
	for _, column := range columns {
		if column.ID == ticket.Status {
			view.Column = column.Name
			view.Done = column.Done
		}
	}
	return view
}

// FindTickets returns the tickets that match a query, in board order and then
// in the order they appear on the board. With a due filter they are sorted by
// deadline instead.
func (s *Store) FindTickets(query TicketQuery, now time.Time) ([]TicketView, error) {
	if query.Due != "" && !containsString(dueFilters, query.Due) {
		return nil, fmt.Errorf("invalid due filter %q: use one of %s", query.Due, strings.Join(dueFilters, ", "))
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.readBoards()
	if err != nil {
		return nil, err
	}
	boards := state.Boards
	if query.Board != "*" {
		boardID, err := s.resolveBoard(query.Board)
		if err != nil {
			return nil, err
		}
		idx, _ := findBoard(state, boardID)
		boards = state.Boards[idx : idx+1]
	}

	words := strings.Fields(strings.ToLower(query.Text))
	project := strings.ToLower(strings.TrimSpace(query.Project))
	statusMatched := false
	results := []TicketView{}
	for _, board := range boards {
		columns := boardColumns(board)
		status := ""
		if query.Status != "" {
			id, ok := resolveStatus(columns, query.Status)
			if !ok {
				continue // this board has no such column
			}
			status = id
			statusMatched = true
		}
		tickets, _, err := s.readBoardTickets(board.ID, s.ticketsPath(board.ID))
		if err != nil {
			return nil, err
		}
		for _, ticket := range tickets {
			done := isDoneStatus(columns, ticket.Status)
			if (status != "" && ticket.Status != status) ||
				(query.ExcludeDone && done) ||
				(project != "" && !strings.Contains(strings.ToLower(ticket.Project), project)) ||
				!matchesDue(ticket, query.Due, done, now) ||
				!matchesText(ticket, words) {
				continue
			}
			results = append(results, viewOf(ticket, board, columns))
		}
	}
	if query.Status != "" && !statusMatched {
		if len(boards) == 1 {
			return nil, invalidStatusError(boardColumns(boards[0]), query.Status)
		}
		return nil, fmt.Errorf("no board has a column called %q", query.Status)
	}
	if query.Due != "" && query.Due != "none" {
		sort.SliceStable(results, func(i, j int) bool { return results[i].Deadline < results[j].Deadline })
	}
	return results, nil
}

// GetTicket returns one active ticket with its board and column names.
func (s *Store) GetTicket(boardRef string, id int64) (TicketView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return TicketView{}, err
	}
	state, err := s.readBoards()
	if err != nil {
		return TicketView{}, err
	}
	idx, _ := findBoard(state, boardID)
	tickets, columns, err := s.readBoardTickets(boardID, s.ticketsPath(boardID))
	if err != nil {
		return TicketView{}, err
	}
	for _, ticket := range tickets {
		if ticket.ID == id {
			return viewOf(ticket, state.Boards[idx], columns), nil
		}
	}
	return TicketView{}, fmt.Errorf("ticket %d not found on board %q", id, state.Boards[idx].Name)
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
