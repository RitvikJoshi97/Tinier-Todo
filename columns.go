package main

import (
	"errors"
	"fmt"
	"strings"
)

// Column is one column of a board. A ticket's status is the id of its column.
// Done marks columns whose tickets count as finished: they get no deadline
// reminders and no overdue colouring.
type Column struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Done bool   `json:"done,omitempty"`
}

const maxColumns = 10

// defaultColumns are the columns of boards made before columns could be
// changed. Their ids are the statuses those versions saved.
func defaultColumns() []Column {
	return []Column{
		{ID: "todo", Name: "To Do"},
		{ID: "inprogress", Name: "In Progress"},
		{ID: "done", Name: "Done", Done: true},
	}
}

// boardColumns returns a board's columns, or the default ones for a board
// saved without any.
func boardColumns(board Board) []Column {
	if len(board.Columns) == 0 {
		return defaultColumns()
	}
	return board.Columns
}

// resolveStatus turns a column id or, ignoring case, a column name into a
// column id.
func resolveStatus(columns []Column, value string) (string, bool) {
	value = strings.TrimSpace(value)
	for _, column := range columns {
		if column.ID == value {
			return column.ID, true
		}
	}
	for _, column := range columns {
		if strings.EqualFold(column.Name, value) {
			return column.ID, true
		}
	}
	return "", false
}

func columnNames(columns []Column) string {
	names := make([]string, len(columns))
	for i, column := range columns {
		names[i] = column.Name
	}
	return strings.Join(names, ", ")
}

func invalidStatusError(columns []Column, value string) error {
	return fmt.Errorf("invalid status %q: this board's columns are %s", value, columnNames(columns))
}

// normalizeStatuses puts tickets whose column no longer exists into the first
// column, so every ticket is always shown somewhere.
func normalizeStatuses(tickets []Ticket, columns []Column) {
	for i := range tickets {
		if id, ok := resolveStatus(columns, tickets[i].Status); ok {
			tickets[i].Status = id
		} else {
			tickets[i].Status = columns[0].ID
		}
	}
}

// mapStatus finds the column of another board that matches a column of this
// one: the same id, then the same name, then the first finished column for a
// finished ticket, then the first column.
func mapStatus(from []Column, to []Column, status string) string {
	if id, ok := resolveStatus(to, status); ok {
		return id
	}
	done := false
	for _, column := range from {
		if column.ID == status {
			if id, ok := resolveStatus(to, column.Name); ok {
				return id
			}
			done = column.Done
		}
	}
	if done {
		for _, column := range to {
			if column.Done {
				return column.ID
			}
		}
	}
	return to[0].ID
}

func isDoneStatus(columns []Column, status string) bool {
	for _, column := range columns {
		if column.ID == status {
			return column.Done
		}
	}
	return false
}

// cleanColumns checks a column list and gives new columns an id. Columns
// whose id is in keep keep it; any other id is replaced.
func cleanColumns(columns []Column, keep map[string]bool) ([]Column, error) {
	if len(columns) == 0 {
		return nil, errors.New("a board needs at least one column")
	}
	if len(columns) > maxColumns {
		return nil, fmt.Errorf("a board can have at most %d columns", maxColumns)
	}
	out := make([]Column, 0, len(columns))
	names := map[string]bool{}
	ids := map[string]bool{}
	for _, column := range columns {
		name := strings.Join(strings.Fields(column.Name), " ")
		if name == "" {
			return nil, errors.New("column names cannot be empty")
		}
		if len([]rune(name)) > 30 {
			return nil, fmt.Errorf("column name %q is longer than 30 characters", name)
		}
		key := strings.ToLower(name)
		if names[key] {
			return nil, fmt.Errorf("there are two columns called %q", name)
		}
		names[key] = true

		id := column.ID
		if !keep[id] || ids[id] {
			id = "c" + randomID()[:8]
		}
		ids[id] = true
		out = append(out, Column{ID: id, Name: name, Done: column.Done})
	}
	return out, nil
}

// columnsFor returns the columns of a board. Callers hold s.mu.
func (s *Store) columnsFor(boardID string) ([]Column, error) {
	state, err := s.readBoards()
	if err != nil {
		return nil, err
	}
	idx, ok := findBoard(state, boardID)
	if !ok {
		return nil, fmt.Errorf("board %q not found", boardID)
	}
	return boardColumns(state.Boards[idx]), nil
}

// readBoardTickets reads a board's tickets (or deleted tickets) with every
// status matched to one of its columns. Callers hold s.mu.
func (s *Store) readBoardTickets(boardID, path string) ([]Ticket, []Column, error) {
	columns, err := s.columnsFor(boardID)
	if err != nil {
		return nil, nil, err
	}
	tickets, err := readTickets(path)
	if err != nil {
		return nil, nil, err
	}
	normalizeStatuses(tickets, columns)
	return tickets, columns, nil
}

// SetBoardColumns replaces a board's columns. Columns are matched to the
// current ones by id, so renaming or reordering a column keeps its tickets.
// The tickets of a removed column move to the nearest column before it that
// remains (or the first column).
func (s *Store) SetBoardColumns(boardID string, columns []Column) (Board, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.readBoards()
	if err != nil {
		return Board{}, err
	}
	idx, ok := findBoard(state, boardID)
	if !ok {
		return Board{}, fmt.Errorf("board %q not found", boardID)
	}
	old := boardColumns(state.Boards[idx])
	keep := map[string]bool{}
	for _, column := range old {
		keep[column.ID] = true
	}
	updated, err := cleanColumns(columns, keep)
	if err != nil {
		return Board{}, err
	}

	remaining := map[string]bool{}
	for _, column := range updated {
		remaining[column.ID] = true
	}
	moveTo := map[string]string{}
	for i, column := range old {
		if remaining[column.ID] {
			continue
		}
		target := updated[0].ID
		for j := i - 1; j >= 0; j-- {
			if remaining[old[j].ID] {
				target = old[j].ID
				break
			}
		}
		moveTo[column.ID] = target
	}

	// Move tickets before saving the new columns: if saving the board fails,
	// every ticket is still in a column that exists.
	if len(moveTo) > 0 {
		for _, path := range []string{s.ticketsPath(boardID), s.deletedPath(boardID)} {
			tickets, err := readTickets(path)
			if err != nil {
				return Board{}, err
			}
			changed := false
			for i := range tickets {
				if target, ok := moveTo[tickets[i].Status]; ok {
					tickets[i].Status = target
					changed = true
				}
			}
			if changed {
				if err := writeTickets(path, tickets); err != nil {
					return Board{}, err
				}
			}
		}
	}

	state.Boards[idx].Columns = updated
	if err := writeJSONAtomic(s.boardsPath(), state, false); err != nil {
		return Board{}, err
	}
	return state.Boards[idx], nil
}

// BoardColumns returns the columns of a board reference (name, id, or "" for
// the open board).
func (s *Store) BoardColumns(boardRef string) (string, []Column, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return "", nil, err
	}
	columns, err := s.columnsFor(boardID)
	return boardID, columns, err
}

// columnsFromNames builds a column list from names, keeping the id and
// finished flag of a current column with the same name. done, when not nil,
// names the columns that count as finished.
func columnsFromNames(current []Column, names []string, done []string) []Column {
	isDone := map[string]bool{}
	for _, name := range done {
		isDone[strings.ToLower(strings.TrimSpace(name))] = true
	}
	columns := make([]Column, 0, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		column := Column{Name: name}
		for _, existing := range current {
			if strings.EqualFold(existing.Name, name) {
				column = Column{ID: existing.ID, Name: name, Done: existing.Done}
			}
		}
		if done != nil {
			column.Done = isDone[strings.ToLower(name)]
		}
		columns = append(columns, column)
	}
	return columns
}
