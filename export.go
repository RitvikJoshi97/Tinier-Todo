package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// ---------- formats ----------

const backupFormat = "tinier-todo-backup"

// Backup is the JSON file written by "Export → Backup of all boards" and
// read by "Import → Backup".
type Backup struct {
	Format     string        `json:"format"`
	Version    int           `json:"version"`
	ExportedAt string        `json:"exportedAt"`
	Boards     []BackupBoard `json:"boards"`
}

type BackupBoard struct {
	Name    string   `json:"name"`
	Columns []Column `json:"columns,omitempty"`
	Tickets []Ticket `json:"tickets"`
	Deleted []Ticket `json:"deleted"`
}

func (s *Store) ExportBackup() (Backup, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.readBoards()
	if err != nil {
		return Backup{}, err
	}
	backup := Backup{Format: backupFormat, Version: 1, ExportedAt: nowRFC3339()}
	for _, board := range state.Boards {
		tickets, _, err := s.readBoardTickets(board.ID, s.ticketsPath(board.ID))
		if err != nil {
			return Backup{}, err
		}
		deleted, _, err := s.readBoardTickets(board.ID, s.deletedPath(board.ID))
		if err != nil {
			return Backup{}, err
		}
		backup.Boards = append(backup.Boards, BackupBoard{
			Name: board.Name, Columns: board.Columns, Tickets: tickets, Deleted: deleted,
		})
	}
	return backup, nil
}

// ImportBackup adds every board in the backup as a new board. Nothing that
// already exists is changed; a name that is taken gets " (2)", " (3)"…
func (s *Store) ImportBackup(backup Backup) ([]Board, error) {
	if backup.Format != backupFormat {
		return nil, errors.New("this file isn't a Tinier Todo backup")
	}
	if len(backup.Boards) == 0 {
		return nil, errors.New("the backup has no boards")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.readBoards()
	if err != nil {
		return nil, err
	}

	var created []Board
	for _, imported := range backup.Boards {
		name, err := cleanBoardName(imported.Name)
		if err != nil {
			name = "Imported board"
		}
		name = uniqueBoardName(state, name)
		// Backups made before columns could be changed have none.
		columns := defaultColumns()
		if len(imported.Columns) > 0 {
			keep := map[string]bool{}
			for _, column := range imported.Columns {
				keep[column.ID] = true
			}
			if cleaned, err := cleanColumns(imported.Columns, keep); err == nil {
				columns = cleaned
			}
		}
		board := Board{ID: randomID(), Name: name, CreatedAt: nowRFC3339(), Columns: columns}

		// Fresh ids keep every ticket id unique across all boards.
		renumber := func(tickets []Ticket) []Ticket {
			out := make([]Ticket, 0, len(tickets))
			for _, ticket := range tickets {
				if strings.TrimSpace(ticket.Name) == "" {
					continue
				}
				ticket.ID = s.nextID()
				// A backup is a file from anywhere: drop links that aren't safe to open.
				if link, err := cleanLink(ticket.Link); err == nil {
					ticket.Link = link
				} else {
					ticket.Link = ""
				}
				if ticket.Comments == nil {
					ticket.Comments = []Comment{}
				}
				assignCommentIDs(ticket.Comments)
				out = append(out, ticket)
			}
			normalizeStatuses(out, columns)
			return out
		}

		if err := os.MkdirAll(s.boardDir(board.ID), 0o700); err != nil {
			return created, err
		}
		if err := writeTickets(s.ticketsPath(board.ID), renumber(imported.Tickets)); err != nil {
			return created, err
		}
		if err := writeTickets(s.deletedPath(board.ID), renumber(imported.Deleted)); err != nil {
			return created, err
		}
		state.Boards = append(state.Boards, board)
		if err := writeJSONAtomic(s.boardsPath(), state, false); err != nil {
			return created, err
		}
		created = append(created, board)
	}
	return created, nil
}

func uniqueBoardName(state BoardsState, name string) string {
	taken := func(candidate string) bool {
		for _, board := range state.Boards {
			if strings.EqualFold(board.Name, candidate) {
				return true
			}
		}
		return false
	}
	if !taken(name) {
		return name
	}
	for n := 2; ; n++ {
		candidate := fmt.Sprintf("%s (%d)", name, n)
		if !taken(candidate) {
			return candidate
		}
	}
}

func (s *Store) boardForExport(boardRef string) (Board, []Ticket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return Board{}, nil, err
	}
	state, err := s.readBoards()
	if err != nil {
		return Board{}, nil, err
	}
	idx, _ := findBoard(state, boardID)
	tickets, _, err := s.readBoardTickets(boardID, s.ticketsPath(boardID))
	return state.Boards[idx], tickets, err
}

// BoardMarkdown renders a board as a Markdown checklist, one section per
// column.
func (s *Store) BoardMarkdown(boardRef string) (string, error) {
	board, tickets, err := s.boardForExport(boardRef)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n", board.Name)
	for _, column := range board.Columns {
		fmt.Fprintf(&b, "\n## %s\n\n", column.Name)
		count := 0
		for _, ticket := range tickets {
			if ticket.Status != column.ID {
				continue
			}
			count++
			box := " "
			if column.Done {
				box = "x"
			}
			var meta []string
			if ticket.Project != "" {
				meta = append(meta, ticket.Project)
			}
			if ticket.Deadline != "" {
				meta = append(meta, "due "+ticket.Deadline)
			}
			line := fmt.Sprintf("- [%s] **%s**", box, oneLine(ticket.Name))
			if len(meta) > 0 {
				line += " — " + strings.Join(meta, " · ")
			}
			b.WriteString(line + "\n")
			if desc := strings.TrimSpace(ticket.Description); desc != "" {
				for _, descLine := range strings.Split(desc, "\n") {
					b.WriteString("  " + strings.TrimRight(descLine, " ") + "\n")
				}
			}
			if ticket.Link != "" {
				fmt.Fprintf(&b, "  <%s>\n", ticket.Link)
			}
		}
		if count == 0 {
			b.WriteString("_No tickets._\n")
		}
	}
	return b.String(), nil
}

const utf8BOM = "\xef\xbb\xbf"

// csvSeparator is ';' for files whose header row uses it: Excel saves CSV
// that way in locales where ',' is the decimal separator (much of Europe).
func csvSeparator(data []byte) rune {
	header := data
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		header = data[:i]
	}
	if bytes.Count(header, []byte(";")) > bytes.Count(header, []byte(",")) {
		return ';'
	}
	return ','
}

// windows1252 holds the characters of bytes 0x80–0x9F, where Windows-1252
// differs from Latin-1 (0 means unused).
var windows1252 = [32]rune{
	0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0,
	0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
}

func decodeWindows1252(data []byte) []byte {
	var b strings.Builder
	b.Grow(len(data))
	for _, c := range data {
		switch {
		case c < 0x80:
			b.WriteByte(c)
		case c < 0xA0 && windows1252[c-0x80] != 0:
			b.WriteRune(windows1252[c-0x80])
		case c < 0xA0:
			b.WriteRune(utf8.RuneError)
		default:
			b.WriteRune(rune(c)) // the same as Latin-1
		}
	}
	return []byte(b.String())
}

func oneLine(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

var csvHeader = []string{"name", "description", "project", "status", "deadline", "link", "comments"}

func (s *Store) BoardCSV(boardRef string) ([]byte, error) {
	board, tickets, err := s.boardForExport(boardRef)
	if err != nil {
		return nil, err
	}
	columnName := map[string]string{}
	for _, column := range board.Columns {
		columnName[column.ID] = column.Name
	}
	var buf bytes.Buffer
	// The byte-order mark makes Excel (on Windows especially) read the file as
	// UTF-8 instead of the system code page.
	buf.WriteString(utf8BOM)
	w := csv.NewWriter(&buf)
	w.UseCRLF = true
	_ = w.Write(csvHeader)
	for _, ticket := range tickets {
		comments := make([]string, 0, len(ticket.Comments))
		for _, comment := range ticket.Comments {
			comments = append(comments, comment.Text)
		}
		_ = w.Write([]string{
			ticket.Name, ticket.Description, ticket.Project, columnName[ticket.Status],
			ticket.Deadline, ticket.Link, strings.Join(comments, "\n---\n"),
		})
	}
	w.Flush()
	return buf.Bytes(), w.Error()
}

// ImportCSV adds one ticket per row to a board. The first row must name the
// columns; "name" (or "title") is required, and description, project,
// status, deadline and link are used when present. Status is matched to the
// board's columns by name; unknown statuses go to the first column.
func (s *Store) ImportCSV(boardRef string, data []byte) (int, error) {
	data = bytes.TrimPrefix(data, []byte(utf8BOM)) // Excel's byte-order mark
	if !utf8.Valid(data) {
		// Excel on Windows saves "CSV (Comma delimited)" in Windows-1252.
		data = decodeWindows1252(data)
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = -1
	r.Comma = csvSeparator(data)
	rows, err := r.ReadAll()
	if err != nil {
		return 0, fmt.Errorf("couldn't read the CSV file: %w", err)
	}
	if len(rows) < 2 {
		return 0, errors.New("the CSV file has no tickets")
	}

	columns := map[string]int{}
	for i, title := range rows[0] {
		key := strings.ToLower(strings.TrimSpace(title))
		if key == "title" {
			key = "name"
		}
		if _, seen := columns[key]; !seen {
			columns[key] = i
		}
	}
	if _, ok := columns["name"]; !ok {
		return 0, errors.New(`the CSV file needs a "name" or "title" column`)
	}
	cell := func(row []string, key string) string {
		if i, ok := columns[key]; ok && i < len(row) {
			return strings.TrimSpace(row[i])
		}
		return ""
	}

	var fields []TicketFields
	for line, row := range rows[1:] {
		name := cell(row, "name")
		if name == "" {
			continue
		}
		ticket := TicketFields{
			Name:        name,
			Description: cell(row, "description"),
			Project:     cell(row, "project"),
			Status:      cell(row, "status"),
			Deadline:    parseDeadline(cell(row, "deadline")),
			Link:        cell(row, "link"),
		}
		ticket, err := validateFields(ticket)
		if err != nil {
			return 0, fmt.Errorf("row %d: %w", line+2, err)
		}
		fields = append(fields, ticket)
	}
	if len(fields) == 0 {
		return 0, errors.New("the CSV file has no tickets with a name")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	boardID, err := s.resolveBoard(boardRef)
	if err != nil {
		return 0, err
	}
	cols, err := s.columnsFor(boardID)
	if err != nil {
		return 0, err
	}
	_, err = s.withTickets(boardID, func(tickets []Ticket) ([]Ticket, bool, error) {
		for _, f := range fields {
			f.Status = parseStatus(cols, f.Status)
			ticket := Ticket{ID: s.nextID(), Comments: []Comment{}}
			applyFields(&ticket, f)
			tickets = append(tickets, ticket)
		}
		return tickets, true, nil
	})
	if err != nil {
		return 0, err
	}
	return len(fields), nil
}

// parseStatus matches a spreadsheet's status to a column: by id or name,
// ignoring spaces and dashes, then common words for "started" and "finished".
func parseStatus(columns []Column, value string) string {
	squash := func(text string) string {
		return strings.ToLower(strings.NewReplacer(" ", "", "-", "", "_", "").Replace(text))
	}
	key := squash(value)
	for _, column := range columns {
		if key == squash(column.ID) || key == squash(column.Name) {
			return column.ID
		}
	}
	switch key {
	case "doing", "started", "inprogress", "wip":
		if len(columns) > 2 {
			return columns[1].ID
		}
	case "done", "complete", "completed", "closed", "finished":
		for _, column := range columns {
			if column.Done {
				return column.ID
			}
		}
	}
	return columns[0].ID
}

// parseDeadline accepts YYYY-MM-DD and a few common spreadsheet formats, and
// drops anything it can't read rather than failing the import.
func parseDeadline(value string) string {
	if value == "" {
		return ""
	}
	for _, layout := range []string{"2006-01-02", "2006/01/02", "2006-01-02T15:04:05Z07:00", "Jan 2, 2006", "2 Jan 2006"} {
		if t, err := time.Parse(layout, value); err == nil {
			return t.Format("2006-01-02")
		}
	}
	return ""
}

// ---------- menu actions (file dialogs) ----------

func safeFileName(name string) string {
	cleaned := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`<>:"/\|?*`, r) || r < 32 {
			return '-'
		}
		return r
	}, name)
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return "board"
	}
	return cleaned
}

func (a *App) toast(message string, isError bool) {
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, "toast", map[string]interface{}{"message": message, "error": isError})
	}
}

func (a *App) saveFile(title, defaultName, pattern, patternName string, data []byte) {
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           title,
		DefaultFilename: defaultName,
		Filters:         []runtime.FileFilter{{DisplayName: patternName, Pattern: pattern}},
	})
	if err != nil {
		a.toast("Couldn't open the save dialog: "+err.Error(), true)
		return
	}
	if path == "" {
		return // cancelled
	}
	if err := writeFileAtomic(path, data); err != nil {
		a.toast("Couldn't save the file: "+err.Error(), true)
		return
	}
	a.toast("Saved "+filepath.Base(path)+".", false)
}

func (a *App) exportBoardMarkdown() {
	board, _, err := a.store.boardForExport("")
	if err != nil {
		a.toast(err.Error(), true)
		return
	}
	text, err := a.store.BoardMarkdown(board.ID)
	if err != nil {
		a.toast(err.Error(), true)
		return
	}
	a.saveFile("Export board as Markdown", safeFileName(board.Name)+".md", "*.md", "Markdown", []byte(text))
}

func (a *App) exportBoardCSV() {
	board, _, err := a.store.boardForExport("")
	if err != nil {
		a.toast(err.Error(), true)
		return
	}
	data, err := a.store.BoardCSV(board.ID)
	if err != nil {
		a.toast(err.Error(), true)
		return
	}
	a.saveFile("Export board as CSV", safeFileName(board.Name)+".csv", "*.csv", "CSV", data)
}

func (a *App) exportBackup() {
	backup, err := a.store.ExportBackup()
	if err != nil {
		a.toast(err.Error(), true)
		return
	}
	data, err := json.MarshalIndent(backup, "", "  ")
	if err != nil {
		a.toast(err.Error(), true)
		return
	}
	name := "tinier-todo-backup-" + time.Now().Format("2006-01-02") + ".json"
	a.saveFile("Back up all boards", name, "*.json", "Tinier Todo backup", data)
}

func (a *App) openFile(title, pattern, patternName string) ([]byte, bool) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   title,
		Filters: []runtime.FileFilter{{DisplayName: patternName, Pattern: pattern}},
	})
	if err != nil {
		a.toast("Couldn't open the file dialog: "+err.Error(), true)
		return nil, false
	}
	if path == "" {
		return nil, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		a.toast("Couldn't read the file: "+err.Error(), true)
		return nil, false
	}
	return data, true
}

func (a *App) importBackup() {
	data, ok := a.openFile("Import a Tinier Todo backup", "*.json", "Tinier Todo backup")
	if !ok {
		return
	}
	var backup Backup
	if err := json.Unmarshal(data, &backup); err != nil {
		a.toast("This file isn't a Tinier Todo backup.", true)
		return
	}
	boards, err := a.store.ImportBackup(backup)
	if len(boards) > 0 {
		a.RefreshMenu()
		runtime.EventsEmit(a.ctx, "ticketsUpdated")
	}
	if err != nil {
		a.toast("Import stopped part way: "+err.Error(), true)
		return
	}
	names := make([]string, len(boards))
	for i, board := range boards {
		names[i] = board.Name
	}
	a.toast(fmt.Sprintf("Imported %d board(s): %s.", len(boards), strings.Join(names, ", ")), false)
}

func (a *App) importCSV() {
	data, ok := a.openFile("Import tickets from CSV", "*.csv", "CSV")
	if !ok {
		return
	}
	count, err := a.store.ImportCSV("", data)
	if err != nil {
		a.toast(err.Error(), true)
		return
	}
	runtime.EventsEmit(a.ctx, "ticketsUpdated")
	a.toast(fmt.Sprintf("Imported %d ticket(s).", count), false)
}
