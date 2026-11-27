package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"
)

// Store owns every file in the data folder. All reads and writes go through
// it, under one mutex, so the UI and the MCP server can never overwrite each
// other's changes.
//
// Layout of the data folder (~/.tinier-todo):
//
//	boards.json                       board list, order and the open board
//	boards/<board-id>/tickets.json    active tickets of one board
//	boards/<board-id>/deleted_tickets.json
//	drafts.json                       unsaved ticket and comment drafts
//	trash/boards/<board-id>-<time>/   deleted boards, kept for recovery
type Store struct {
	mu     sync.Mutex
	dir    string
	lastID int64
}

type Comment struct {
	// ID is unique within its ticket. Comments saved before ids existed get
	// one from their position when read (see readTickets).
	ID        int64  `json:"id"`
	Text      string `json:"text"`
	Timestamp string `json:"timestamp"`
	EditedAt  string `json:"editedAt,omitempty"`
}

type Ticket struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Project     string    `json:"project"`
	Link        string    `json:"link"`
	Deadline    string    `json:"deadline"`
	Status      string    `json:"status"`
	Comments    []Comment `json:"comments"`
	DeletedAt   string    `json:"deletedAt,omitempty"`
}

// TicketFields are the user-editable fields of a ticket.
type TicketFields struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Project     string `json:"project"`
	Link        string `json:"link"`
	Deadline    string `json:"deadline"`
	Status      string `json:"status"`
}

// TicketPatch changes only the fields that are set.
type TicketPatch struct {
	Name        *string
	Description *string
	Project     *string
	Link        *string
	Deadline    *string
	Status      *string
}

type Board struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	CreatedAt string   `json:"createdAt"`
	Columns   []Column `json:"columns"`
}

type BoardsState struct {
	Boards        []Board `json:"boards"`
	ActiveBoardID string  `json:"activeBoardId"`
}

type Draft struct {
	Fields    map[string]string `json:"fields"`
	UpdatedAt string            `json:"updatedAt"`
}

const defaultBoardID = "default"

// defaultDataDir returns ~/.tinier-todo.
func defaultDataDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".tinier-todo"), nil
}

// NewStore opens the data folder, creating it and migrating the single-board
// layout of earlier versions if needed.
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	secureDataDir(dir)

	s := &Store{dir: dir}
	if err := s.migrate(); err != nil {
		return nil, fmt.Errorf("failed to prepare data folder: %w", err)
	}

	state, err := s.readBoards()
	if err != nil {
		return nil, err
	}
	for _, board := range state.Boards {
		for _, path := range []string{s.ticketsPath(board.ID), s.deletedPath(board.ID)} {
			tickets, err := readTickets(path)
			if err != nil {
				continue
			}
			for _, ticket := range tickets {
				if ticket.ID > s.lastID {
					s.lastID = ticket.ID
				}
			}
		}
	}

	return s, nil
}

func (s *Store) Dir() string { return s.dir }

func (s *Store) boardsPath() string        { return filepath.Join(s.dir, "boards.json") }
func (s *Store) draftsPath() string        { return filepath.Join(s.dir, "drafts.json") }
func (s *Store) boardDir(id string) string { return filepath.Join(s.dir, "boards", id) }
func (s *Store) ticketsPath(id string) string {
	return filepath.Join(s.boardDir(id), "tickets.json")
}
func (s *Store) deletedPath(id string) string {
	return filepath.Join(s.boardDir(id), "deleted_tickets.json")
}

// migrate moves tickets.json and deleted_tickets.json from the top of the data
// folder (the layout before boards existed) into a board called "Default".
// Every step is safe to repeat if the app stops half way.
func (s *Store) migrate() error {
	if _, err := os.Stat(s.boardsPath()); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}

	if err := os.MkdirAll(s.boardDir(defaultBoardID), 0o700); err != nil {
		return err
	}

	legacy := map[string]string{
		filepath.Join(s.dir, "tickets.json"):         s.ticketsPath(defaultBoardID),
		filepath.Join(s.dir, "deleted_tickets.json"): s.deletedPath(defaultBoardID),
	}
	for from, to := range legacy {
		if _, err := os.Stat(from); err != nil {
			continue
		}
		if _, err := os.Stat(to); err == nil {
			continue // already moved on an earlier run
		}
		if err := os.Rename(from, to); err != nil {
			return err
		}
	}

	return writeJSONAtomic(s.boardsPath(), BoardsState{
		Boards:        []Board{{ID: defaultBoardID, Name: "Default", CreatedAt: nowRFC3339()}},
		ActiveBoardID: defaultBoardID,
	}, false)
}

// ---------- low-level file helpers ----------

// writeJSONAtomic writes to a temporary file and renames it over the target,
// so a crash mid-write never leaves a half-written file. With backup set, the
// previous contents are kept next to it as <name>.bak, as long as they were
// valid JSON.
func writeJSONAtomic(path string, value interface{}, backup bool) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	if backup {
		if previous, err := os.ReadFile(path); err == nil && json.Valid(previous) {
			if err := writeFileAtomic(path+".bak", previous); err != nil {
				log.Printf("Failed to write backup of %s: %v", path, err)
			}
		}
	}

	return writeFileAtomic(path, data)
}

func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := renameWithRetry(tmpName, path); err != nil {
		cleanup()
		return err
	}
	return nil
}

// renameWithRetry replaces path with tmp. On Windows the rename fails while
// another program has the file open, which antivirus scanners, backup and
// sync tools (OneDrive, Dropbox) and search indexing do for a moment after
// every change, so it tries again for up to about a second.
func renameWithRetry(tmp, path string) error {
	err := os.Rename(tmp, path)
	if goruntime.GOOS != "windows" {
		return err
	}
	for attempt := 0; err != nil && attempt < 10; attempt++ {
		time.Sleep(time.Duration(20*(attempt+1)) * time.Millisecond)
		err = os.Rename(tmp, path)
	}
	return err
}

// readJSON reads path into value. A missing file leaves value untouched. A
// corrupt file falls back to its .bak copy when there is one.
func readJSON(path string, value interface{}) error {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}

	if err := json.Unmarshal(data, value); err != nil {
		backup, backupErr := os.ReadFile(path + ".bak")
		if backupErr == nil && json.Unmarshal(backup, value) == nil {
			log.Printf("%s is unreadable (%v); using %s.bak", path, err, path)
			return nil
		}
		return fmt.Errorf("failed to read %s: %w", filepath.Base(path), err)
	}
	return nil
}

func readTickets(path string) ([]Ticket, error) {
	tickets := []Ticket{}
	if err := readJSON(path, &tickets); err != nil {
		return nil, err
	}
	if tickets == nil {
		tickets = []Ticket{}
	}
	for i := range tickets {
		if tickets[i].Comments == nil {
			tickets[i].Comments = []Comment{}
		}
		assignCommentIDs(tickets[i].Comments)
	}
	return tickets, nil
}

// assignCommentIDs gives comments without an id (saved by older versions)
// the next free one, in order, so the result is the same on every read.
func assignCommentIDs(comments []Comment) {
	var maxID int64
	for _, comment := range comments {
		if comment.ID > maxID {
			maxID = comment.ID
		}
	}
	for i := range comments {
		if comments[i].ID == 0 {
			maxID++
			comments[i].ID = maxID
		}
	}
}

func nextCommentID(comments []Comment) int64 {
	var maxID int64
	for _, comment := range comments {
		if comment.ID > maxID {
			maxID = comment.ID
		}
	}
	return maxID + 1
}

func writeTickets(path string, tickets []Ticket) error {
	if tickets == nil {
		tickets = []Ticket{}
	}
	return writeJSONAtomic(path, tickets, true)
}

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }

func randomID() string {
	b := make([]byte, 5)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("b%d", time.Now().UnixNano())
	}
	return "b" + hex.EncodeToString(b)
}

// nextID returns a new ticket id: the current time in milliseconds, or one
// more than the last id handed out, whichever is larger. Ids stay numeric so
// existing tickets keep working. Callers hold s.mu.
func (s *Store) nextID() int64 {
	id := time.Now().UnixMilli()
	if id <= s.lastID {
		id = s.lastID + 1
	}
	s.lastID = id
	return id
}

// ---------- boards ----------

func (s *Store) readBoards() (BoardsState, error) {
	var state BoardsState
	if err := readJSON(s.boardsPath(), &state); err != nil {
		return BoardsState{}, err
	}
	if len(state.Boards) == 0 {
		state.Boards = []Board{{ID: defaultBoardID, Name: "Default", CreatedAt: nowRFC3339()}}
	}
	if _, ok := findBoard(state, state.ActiveBoardID); !ok {
		state.ActiveBoardID = state.Boards[0].ID
	}
	for i := range state.Boards {
		state.Boards[i].Columns = boardColumns(state.Boards[i])
	}
	return state, nil
}

func findBoard(state BoardsState, id string) (int, bool) {
	for i, board := range state.Boards {
		if board.ID == id {
			return i, true
		}
	}
	return -1, false
}

// resolveBoard turns a board reference into a board id. An empty reference
// means the open board. A reference can be a board id or, ignoring case, a
// board name. Callers hold s.mu.
func (s *Store) resolveBoard(ref string) (string, error) {
	state, err := s.readBoards()
	if err != nil {
		return "", err
	}
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return state.ActiveBoardID, nil
	}
	if _, ok := findBoard(state, ref); ok {
		return ref, nil
	}
	for _, board := range state.Boards {
		if strings.EqualFold(board.Name, ref) {
			return board.ID, nil
		}
	}
	return "", fmt.Errorf("board %q not found", ref)
}

func (s *Store) ResolveBoard(ref string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.resolveBoard(ref)
}

func (s *Store) Boards() (BoardsState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readBoards()
}

func cleanBoardName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("board name cannot be empty")
	}
	if len([]rune(name)) > 60 {
		return "", errors.New("board name must be 60 characters or fewer")
	}
	return name, nil
}

func (s *Store) CreateBoard(name string) (Board, error) {
	return s.CreateBoardWithColumns(name, nil)
}

// CreateBoardWithColumns makes a board with the given columns, or the default
// To Do / In Progress / Done when columns is empty.
func (s *Store) CreateBoardWithColumns(name string, columns []Column) (Board, error) {
	name, err := cleanBoardName(name)
	if err != nil {
		return Board{}, err
	}
	if len(columns) == 0 {
		columns = defaultColumns()
	} else if columns, err = cleanColumns(columns, nil); err != nil {
		return Board{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.readBoards()
	if err != nil {
		return Board{}, err
	}
	for _, board := range state.Boards {
		if strings.EqualFold(board.Name, name) {
			return Board{}, fmt.Errorf("a board called %q already exists", board.Name)
		}
	}

	board := Board{ID: randomID(), Name: name, CreatedAt: nowRFC3339(), Columns: columns}
	if err := os.MkdirAll(s.boardDir(board.ID), 0o700); err != nil {
		return Board{}, err
	}
	state.Boards = append(state.Boards, board)
	if err := writeJSONAtomic(s.boardsPath(), state, false); err != nil {
		return Board{}, err
	}
	return board, nil
}

func (s *Store) RenameBoard(id, name string) error {
	name, err := cleanBoardName(name)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.readBoards()
	if err != nil {
		return err
	}
	idx, ok := findBoard(state, id)
	if !ok {
		return fmt.Errorf("board %q not found", id)
	}
	for _, board := range state.Boards {
		if board.ID != id && strings.EqualFold(board.Name, name) {
			return fmt.Errorf("a board called %q already exists", board.Name)
		}
	}
	state.Boards[idx].Name = name
	return writeJSONAtomic(s.boardsPath(), state, false)
}

// DeleteBoard removes a board from the list and moves its folder to
// trash/boards, so its tickets can still be recovered by hand.
func (s *Store) DeleteBoard(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.readBoards()
	if err != nil {
		return err
	}
	idx, ok := findBoard(state, id)
	if !ok {
		return fmt.Errorf("board %q not found", id)
	}
	if len(state.Boards) == 1 {
		return errors.New("you can't delete the only board")
	}

	trashDir := filepath.Join(s.dir, "trash", "boards")
	if err := os.MkdirAll(trashDir, 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(s.boardDir(id)); err == nil {
		target := filepath.Join(trashDir, fmt.Sprintf("%s-%d", id, time.Now().Unix()))
		if err := os.Rename(s.boardDir(id), target); err != nil {
			return err
		}
	}

	state.Boards = append(state.Boards[:idx], state.Boards[idx+1:]...)
	if state.ActiveBoardID == id {
		next := idx
		if next >= len(state.Boards) {
			next = len(state.Boards) - 1
		}
		state.ActiveBoardID = state.Boards[next].ID
	}
	if err := writeJSONAtomic(s.boardsPath(), state, false); err != nil {
		return err
	}

	return s.deleteDraftsWithPrefix(draftBoardPrefix(id))
}

// ReorderBoards sets the board order. ids must name every board exactly once.
func (s *Store) ReorderBoards(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.readBoards()
	if err != nil {
		return err
	}
	if len(ids) != len(state.Boards) {
		return errors.New("board order must list every board once")
	}
	reordered := make([]Board, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		idx, ok := findBoard(state, id)
		if !ok || seen[id] {
			return errors.New("board order must list every board once")
		}
		seen[id] = true
		reordered = append(reordered, state.Boards[idx])
	}
	state.Boards = reordered
	return writeJSONAtomic(s.boardsPath(), state, false)
}

func (s *Store) SetActiveBoard(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.readBoards()
	if err != nil {
		return err
	}
	if _, ok := findBoard(state, id); !ok {
		return fmt.Errorf("board %q not found", id)
	}
	if state.ActiveBoardID == id {
		return nil
	}
	state.ActiveBoardID = id
	return writeJSONAtomic(s.boardsPath(), state, false)
}

// ---------- tickets ----------

func validateFields(fields TicketFields) (TicketFields, error) {
	fields.Name = strings.TrimSpace(fields.Name)
	fields.Project = strings.TrimSpace(fields.Project)
	fields.Link = strings.TrimSpace(fields.Link)
	fields.Deadline = strings.TrimSpace(fields.Deadline)

	if fields.Name == "" {
		return fields, errors.New(`"name" is required`)
	}
	if fields.Deadline != "" {
		if _, err := time.Parse("2006-01-02", fields.Deadline); err != nil {
			return fields, fmt.Errorf("invalid deadline %q: use YYYY-MM-DD", fields.Deadline)
		}
	}
	link, err := cleanLink(fields.Link)
	if err != nil {
		return fields, err
	}
	fields.Link = link
	return fields, nil
}

// resolveFieldStatus sets fields.Status to a column id of the board; an empty
// status means the first column.
func resolveFieldStatus(fields *TicketFields, columns []Column) error {
	if strings.TrimSpace(fields.Status) == "" {
		fields.Status = columns[0].ID
		return nil
	}
	id, ok := resolveStatus(columns, fields.Status)
	if !ok {
		return invalidStatusError(columns, fields.Status)
	}
	fields.Status = id
	return nil
}

func applyFields(ticket *Ticket, fields TicketFields) {
	ticket.Name = fields.Name
	ticket.Description = fields.Description
	ticket.Project = fields.Project
	ticket.Link = fields.Link
	ticket.Deadline = fields.Deadline
	ticket.Status = fields.Status
}

func fieldsOf(ticket Ticket) TicketFields {
	return TicketFields{
		Name:        ticket.Name,
		Description: ticket.Description,
		Project:     ticket.Project,
		Link:        ticket.Link,
		Deadline:    ticket.Deadline,
		Status:      ticket.Status,
	}
}

func findTicket(tickets []Ticket, id int64) int {
	for i, ticket := range tickets {
		if ticket.ID == id {
			return i
		}
	}
	return -1
}

// withTickets loads a board's active tickets, lets fn change them and saves
// the result if fn returns save=true. Callers hold s.mu.
func (s *Store) withTickets(boardID string, fn func([]Ticket) ([]Ticket, bool, error)) ([]Ticket, error) {
	tickets, _, err := s.readBoardTickets(boardID, s.ticketsPath(boardID))
	if err != nil {
		return nil, err
	}
	updated, save, err := fn(tickets)
	if err != nil {
		return nil, err
	}
	if save {
		if err := writeTickets(s.ticketsPath(boardID), updated); err != nil {
			return nil, fmt.Errorf("failed to save tickets: %w", err)
		}
	}
	return updated, nil
}

func (s *Store) Tickets(boardRef string) ([]Ticket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return nil, err
	}
	tickets, _, err := s.readBoardTickets(boardID, s.ticketsPath(boardID))
	return tickets, err
}

func (s *Store) DeletedTickets(boardRef string) ([]Ticket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return nil, err
	}
	tickets, _, err := s.readBoardTickets(boardID, s.deletedPath(boardID))
	return tickets, err
}

func (s *Store) CreateTicket(boardRef string, fields TicketFields) (Ticket, error) {
	fields, err := validateFields(fields)
	if err != nil {
		return Ticket{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return Ticket{}, err
	}
	columns, err := s.columnsFor(boardID)
	if err != nil {
		return Ticket{}, err
	}
	if err := resolveFieldStatus(&fields, columns); err != nil {
		return Ticket{}, err
	}

	ticket := Ticket{ID: s.nextID(), Comments: []Comment{}}
	applyFields(&ticket, fields)
	_, err = s.withTickets(boardID, func(tickets []Ticket) ([]Ticket, bool, error) {
		return append(tickets, ticket), true, nil
	})
	if err != nil {
		return Ticket{}, err
	}
	_ = s.deleteDraft(draftKey("new", boardID, 0))
	return ticket, nil
}

func (s *Store) UpdateTicket(boardRef string, id int64, fields TicketFields) (Ticket, error) {
	fields, err := validateFields(fields)
	if err != nil {
		return Ticket{}, err
	}
	ticket, err := s.patchTicket(boardRef, id, func(ticket *Ticket, columns []Column) error {
		if err := resolveFieldStatus(&fields, columns); err != nil {
			return err
		}
		applyFields(ticket, fields)
		return nil
	})
	if err == nil {
		s.deleteDraftFor("edit", boardRef, id)
	}
	return ticket, err
}

// deleteDraftFor removes the draft of one kind for a ticket after it has been
// saved.
func (s *Store) deleteDraftFor(kind, boardRef string, id int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if boardID, err := s.resolveBoard(boardRef); err == nil {
		_ = s.deleteDraft(draftKey(kind, boardID, id))
	}
}

func (s *Store) PatchTicket(boardRef string, id int64, patch TicketPatch) (Ticket, error) {
	return s.patchTicket(boardRef, id, func(ticket *Ticket, columns []Column) error {
		fields := fieldsOf(*ticket)
		for _, change := range []struct {
			value  *string
			target *string
		}{
			{patch.Name, &fields.Name},
			{patch.Description, &fields.Description},
			{patch.Project, &fields.Project},
			{patch.Link, &fields.Link},
			{patch.Deadline, &fields.Deadline},
			{patch.Status, &fields.Status},
		} {
			if change.value != nil {
				*change.target = *change.value
			}
		}
		fields, err := validateFields(fields)
		if err != nil {
			return err
		}
		if err := resolveFieldStatus(&fields, columns); err != nil {
			return err
		}
		applyFields(ticket, fields)
		return nil
	})
}

// MoveTicket changes a ticket's status. A ticket that changes column goes to
// the bottom of its new column; one already in that column keeps its place.
func (s *Store) MoveTicket(boardRef string, id int64, status string) (Ticket, error) {
	return s.placeTicket(boardRef, id, status, 0, true)
}

// PlaceTicket puts a ticket in a column, just above the ticket beforeID, or
// at the bottom of the column when beforeID is 0. The order of tickets in
// tickets.json is the order they are shown in each column.
func (s *Store) PlaceTicket(boardRef string, id int64, status string, beforeID int64) (Ticket, error) {
	return s.placeTicket(boardRef, id, status, beforeID, false)
}

func (s *Store) placeTicket(boardRef string, id int64, status string, beforeID int64, keepPlaceInColumn bool) (Ticket, error) {
	if beforeID == id {
		beforeID = 0
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return Ticket{}, err
	}
	columns, err := s.columnsFor(boardID)
	if err != nil {
		return Ticket{}, err
	}
	resolved, ok := resolveStatus(columns, status)
	if !ok {
		return Ticket{}, invalidStatusError(columns, status)
	}
	status = resolved

	var result Ticket
	_, err = s.withTickets(boardID, func(tickets []Ticket) ([]Ticket, bool, error) {
		idx := findTicket(tickets, id)
		if idx == -1 {
			return nil, false, fmt.Errorf("ticket %d not found", id)
		}
		ticket := tickets[idx]
		if keepPlaceInColumn && ticket.Status == status {
			result = ticket // already in that column; keep its place
			return tickets, false, nil
		}
		ticket.Status = status
		rest := append(append([]Ticket{}, tickets[:idx]...), tickets[idx+1:]...)

		// The bottom of the column: just after its last ticket.
		insertAt := len(rest)
		for i := len(rest) - 1; i >= 0; i-- {
			if rest[i].Status == status {
				insertAt = i + 1
				break
			}
		}
		if beforeID != 0 {
			before := findTicket(rest, beforeID)
			if before == -1 {
				return nil, false, fmt.Errorf("ticket %d not found", beforeID)
			}
			if rest[before].Status != status {
				return nil, false, fmt.Errorf("ticket %d is not in that column", beforeID)
			}
			insertAt = before
		}

		placed := make([]Ticket, 0, len(tickets))
		placed = append(placed, rest[:insertAt]...)
		placed = append(placed, ticket)
		placed = append(placed, rest[insertAt:]...)
		result = ticket
		return placed, true, nil
	})
	return result, err
}

func (s *Store) AddComment(boardRef string, id int64, text string) (Ticket, error) {
	if strings.TrimSpace(text) == "" {
		return Ticket{}, errors.New("comment cannot be empty")
	}
	ticket, err := s.patchTicket(boardRef, id, func(ticket *Ticket, _ []Column) error {
		ticket.Comments = append(ticket.Comments, Comment{
			ID:        nextCommentID(ticket.Comments),
			Text:      text,
			Timestamp: time.Now().Format("Jan 2, 2006, 3:04 PM"),
		})
		return nil
	})
	if err == nil {
		s.deleteDraftFor("comment", boardRef, id)
	}
	return ticket, err
}

func (s *Store) EditComment(boardRef string, ticketID, commentID int64, text string) (Ticket, error) {
	if strings.TrimSpace(text) == "" {
		return Ticket{}, errors.New("comment cannot be empty")
	}
	return s.patchTicket(boardRef, ticketID, func(ticket *Ticket, _ []Column) error {
		for i := range ticket.Comments {
			if ticket.Comments[i].ID == commentID {
				ticket.Comments[i].Text = text
				ticket.Comments[i].EditedAt = nowRFC3339()
				return nil
			}
		}
		return fmt.Errorf("comment %d not found", commentID)
	})
}

func (s *Store) DeleteComment(boardRef string, ticketID, commentID int64) (Ticket, error) {
	return s.patchTicket(boardRef, ticketID, func(ticket *Ticket, _ []Column) error {
		for i := range ticket.Comments {
			if ticket.Comments[i].ID == commentID {
				ticket.Comments = append(ticket.Comments[:i], ticket.Comments[i+1:]...)
				return nil
			}
		}
		return fmt.Errorf("comment %d not found", commentID)
	})
}

func (s *Store) patchTicket(boardRef string, id int64, change func(*Ticket, []Column) error) (Ticket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return Ticket{}, err
	}
	columns, err := s.columnsFor(boardID)
	if err != nil {
		return Ticket{}, err
	}

	var result Ticket
	_, err = s.withTickets(boardID, func(tickets []Ticket) ([]Ticket, bool, error) {
		idx := findTicket(tickets, id)
		if idx == -1 {
			return nil, false, fmt.Errorf("ticket %d not found", id)
		}
		if err := change(&tickets[idx], columns); err != nil {
			return nil, false, err
		}
		result = tickets[idx]
		return tickets, true, nil
	})
	return result, err
}

// DeleteTicket moves a ticket to the board's deleted list.
func (s *Store) DeleteTicket(boardRef string, id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return err
	}

	tickets, err := readTickets(s.ticketsPath(boardID))
	if err != nil {
		return err
	}
	idx := findTicket(tickets, id)
	if idx == -1 {
		return fmt.Errorf("ticket %d not found", id)
	}
	deleted, err := readTickets(s.deletedPath(boardID))
	if err != nil {
		return err
	}

	removed := tickets[idx]
	removed.DeletedAt = nowRFC3339()
	tickets = append(tickets[:idx], tickets[idx+1:]...)

	// Write the deleted list first: if the second write fails the ticket is
	// in both lists, never in neither.
	if err := writeTickets(s.deletedPath(boardID), append([]Ticket{removed}, deleted...)); err != nil {
		return err
	}
	if err := writeTickets(s.ticketsPath(boardID), tickets); err != nil {
		return err
	}

	_ = s.deleteDraft(draftKey("edit", boardID, id))
	_ = s.deleteDraft(draftKey("comment", boardID, id))
	return nil
}

// RestoreTicket moves a ticket from the board's deleted list back onto the
// board.
func (s *Store) RestoreTicket(boardRef string, id int64) (Ticket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return Ticket{}, err
	}

	deleted, _, err := s.readBoardTickets(boardID, s.deletedPath(boardID))
	if err != nil {
		return Ticket{}, err
	}
	idx := findTicket(deleted, id)
	if idx == -1 {
		return Ticket{}, fmt.Errorf("deleted ticket %d not found", id)
	}
	tickets, err := readTickets(s.ticketsPath(boardID))
	if err != nil {
		return Ticket{}, err
	}

	restored := deleted[idx]
	restored.DeletedAt = ""
	if findTicket(tickets, restored.ID) != -1 {
		restored.ID = s.nextID()
	}
	deleted = append(deleted[:idx], deleted[idx+1:]...)

	// Add to the board first: a failure part way leaves a duplicate in the
	// deleted list rather than losing the ticket.
	if err := writeTickets(s.ticketsPath(boardID), append(tickets, restored)); err != nil {
		return Ticket{}, err
	}
	if err := writeTickets(s.deletedPath(boardID), deleted); err != nil {
		return Ticket{}, err
	}
	return restored, nil
}

// MoveTicketToBoard moves an active ticket, with its comments, to another
// board.
func (s *Store) MoveTicketToBoard(fromRef string, id int64, toRef string) (Ticket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fromID, err := s.resolveBoard(fromRef)
	if err != nil {
		return Ticket{}, err
	}
	toID, err := s.resolveBoard(toRef)
	if err != nil {
		return Ticket{}, err
	}
	if fromID == toID {
		return Ticket{}, errors.New("the ticket is already on that board")
	}

	source, fromColumns, err := s.readBoardTickets(fromID, s.ticketsPath(fromID))
	if err != nil {
		return Ticket{}, err
	}
	idx := findTicket(source, id)
	if idx == -1 {
		return Ticket{}, fmt.Errorf("ticket %d not found", id)
	}
	target, toColumns, err := s.readBoardTickets(toID, s.ticketsPath(toID))
	if err != nil {
		return Ticket{}, err
	}

	moved := source[idx]
	moved.Status = mapStatus(fromColumns, toColumns, moved.Status)
	if findTicket(target, moved.ID) != -1 {
		moved.ID = s.nextID()
	}
	source = append(source[:idx], source[idx+1:]...)

	if err := writeTickets(s.ticketsPath(toID), append(target, moved)); err != nil {
		return Ticket{}, err
	}
	if err := writeTickets(s.ticketsPath(fromID), source); err != nil {
		return Ticket{}, err
	}

	_ = s.deleteDraft(draftKey("edit", fromID, id))
	_ = s.deleteDraft(draftKey("comment", fromID, id))
	return moved, nil
}

// ---------- drafts ----------

// Draft keys look like "new:<board>", "edit:<board>:<ticket>" or
// "comment:<board>:<ticket>".
func draftKey(kind, boardID string, ticketID int64) string {
	if kind == "new" {
		return "new:" + boardID
	}
	return fmt.Sprintf("%s:%s:%d", kind, boardID, ticketID)
}

func draftBoardPrefix(boardID string) []string {
	return []string{"new:" + boardID, "edit:" + boardID + ":", "comment:" + boardID + ":"}
}

func validDraftKey(key string) bool {
	if len(key) == 0 || len(key) > 200 {
		return false
	}
	for _, kind := range []string{"new:", "edit:", "comment:"} {
		if strings.HasPrefix(key, kind) {
			return true
		}
	}
	return false
}

func (s *Store) readDrafts() (map[string]Draft, error) {
	drafts := map[string]Draft{}
	if err := readJSON(s.draftsPath(), &drafts); err != nil {
		return nil, err
	}
	if drafts == nil {
		drafts = map[string]Draft{}
	}
	return drafts, nil
}

func (s *Store) GetDraft(key string) (*Draft, error) {
	if !validDraftKey(key) {
		return nil, fmt.Errorf("invalid draft key %q", key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	drafts, err := s.readDrafts()
	if err != nil {
		return nil, err
	}
	draft, ok := drafts[key]
	if !ok {
		return nil, nil
	}
	return &draft, nil
}

// DraftKeys lists the keys of every saved draft.
func (s *Store) DraftKeys() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	drafts, err := s.readDrafts()
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(drafts))
	for key := range drafts {
		keys = append(keys, key)
	}
	return keys, nil
}

func (s *Store) SaveDraft(key string, fields map[string]string) error {
	if !validDraftKey(key) {
		return fmt.Errorf("invalid draft key %q", key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	drafts, err := s.readDrafts()
	if err != nil {
		return err
	}
	drafts[key] = Draft{Fields: fields, UpdatedAt: nowRFC3339()}
	return writeJSONAtomic(s.draftsPath(), drafts, false)
}

func (s *Store) DeleteDraft(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.deleteDraft(key)
}

// deleteDraft removes one draft. Callers hold s.mu.
func (s *Store) deleteDraft(key string) error {
	drafts, err := s.readDrafts()
	if err != nil {
		return err
	}
	if _, ok := drafts[key]; !ok {
		return nil
	}
	delete(drafts, key)
	return writeJSONAtomic(s.draftsPath(), drafts, false)
}

// deleteDraftsWithPrefix removes every draft whose key equals one of the
// prefixes or, for a prefix ending in ":", starts with it. Callers hold s.mu.
func (s *Store) deleteDraftsWithPrefix(prefixes []string) error {
	drafts, err := s.readDrafts()
	if err != nil {
		return err
	}
	changed := false
	for key := range drafts {
		for _, prefix := range prefixes {
			if key == prefix || (strings.HasSuffix(prefix, ":") && strings.HasPrefix(key, prefix)) {
				delete(drafts, key)
				changed = true
				break
			}
		}
	}
	if !changed {
		return nil
	}
	return writeJSONAtomic(s.draftsPath(), drafts, false)
}
