package main

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/server"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App holds the state shared by the UI bindings and the MCP server.
type App struct {
	ctx   context.Context
	store *Store

	mcpMu       sync.Mutex
	mcpHTTP     *mcpHTTPServer
	mcpSettings MCPSettings
}

// mcpHTTPServer groups the HTTP server and the two MCP transports it serves.
type mcpHTTPServer struct {
	sse        *server.SSEServer
	streamable *server.StreamableHTTPServer
	stop       func(context.Context) error
}

// NewApp creates the app. It must not touch the data folder: `wails build`
// and `wails generate` run main() to read the bindings, and opening the store
// here would migrate the user's real data as a side effect of building.
func NewApp() *App {
	return &App{}
}

// startup opens the data folder. Wails calls it before the UI loads, so the
// store is ready for every call the UI makes.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	dir, err := defaultDataDir()
	if err == nil {
		a.store, err = NewStore(dir)
	}
	if err != nil {
		log.Printf("Cannot open the data folder: %v", err)
		_, _ = runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
			Type:    runtime.ErrorDialog,
			Title:   "Tinier Todo can't open its data",
			Message: fmt.Sprintf("Tinier Todo could not open %s:\n\n%v", dir, err),
		})
		runtime.Quit(ctx)
		return
	}

	a.RefreshMenu()
	a.restoreWindowPosition(loadWindowState())
	a.initializeMCP()
	a.startDataWatcher()
	a.startReminders()
}

func (a *App) shutdown(ctx context.Context) {
	_ = a.stopMCPServer()
}

// startDataWatcher tells the UI to reload when any board file changes on
// disk, whether the change came from the MCP server, from another copy of the
// app or from someone editing the files by hand.
func (a *App) startDataWatcher() {
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()

		last := a.dataFingerprint()
		lastBoards := getFileModTime(a.store.boardsPath())
		for range ticker.C {
			current := a.dataFingerprint()
			if current == last {
				continue
			}
			last = current
			if boards := getFileModTime(a.store.boardsPath()); !boards.Equal(lastBoards) {
				lastBoards = boards
				a.RefreshMenu() // board names or order changed
			}
			runtime.EventsEmit(a.ctx, "ticketsUpdated")
		}
	}()
}

func (a *App) dataFingerprint() string {
	var b strings.Builder
	addFile := func(path string, info fs.FileInfo) {
		fmt.Fprintf(&b, "%s %d %d\n", path, info.ModTime().UnixNano(), info.Size())
	}
	if info, err := os.Stat(a.store.boardsPath()); err == nil {
		addFile("boards.json", info)
	}
	_ = filepath.WalkDir(filepath.Join(a.store.Dir(), "boards"), func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".json") {
			return nil
		}
		if info, err := d.Info(); err == nil {
			addFile(path, info)
		}
		return nil
	})
	return b.String()
}

func getFileModTime(path string) time.Time {
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

// version is set at build time by the release workflow:
// wails build -ldflags "-X main.version=1.2.3"
var version = "dev"

// GetVersion returns the app version shown in the About dialog.
func (a *App) GetVersion() string {
	return version
}

// ---------- boards ----------

func (a *App) GetBoards() (BoardsState, error) {
	return a.store.Boards()
}

// CreateBoard makes a board. With no columns it gets To Do, In Progress and
// Done.
func (a *App) CreateBoard(name string, columns []Column) (Board, error) {
	board, err := a.store.CreateBoardWithColumns(name, columns)
	if err == nil {
		a.RefreshMenu()
	}
	return board, err
}

// SetBoardColumns renames, adds, removes and reorders a board's columns.
func (a *App) SetBoardColumns(boardID string, columns []Column) (Board, error) {
	return a.store.SetBoardColumns(boardID, columns)
}

func (a *App) RenameBoard(id, name string) error {
	return a.refreshMenuAfter(a.store.RenameBoard(id, name))
}

func (a *App) DeleteBoard(id string) error {
	return a.refreshMenuAfter(a.store.DeleteBoard(id))
}

func (a *App) ReorderBoards(ids []string) error {
	return a.refreshMenuAfter(a.store.ReorderBoards(ids))
}

func (a *App) SetActiveBoard(id string) error {
	return a.refreshMenuAfter(a.store.SetActiveBoard(id))
}

func (a *App) refreshMenuAfter(err error) error {
	if err == nil {
		a.RefreshMenu()
	}
	return err
}

// ---------- tickets ----------

func (a *App) LoadTickets(boardID string) ([]Ticket, error) {
	return a.store.Tickets(boardID)
}

func (a *App) LoadDeletedTickets(boardID string) ([]Ticket, error) {
	return a.store.DeletedTickets(boardID)
}

func (a *App) CreateTicket(boardID string, fields TicketFields) (Ticket, error) {
	return a.store.CreateTicket(boardID, fields)
}

func (a *App) UpdateTicket(boardID string, id int64, fields TicketFields) (Ticket, error) {
	return a.store.UpdateTicket(boardID, id, fields)
}

func (a *App) MoveTicket(boardID string, id int64, status string) (Ticket, error) {
	return a.store.MoveTicket(boardID, id, status)
}

// PlaceTicket moves a ticket into a column above beforeID (0 = at the bottom).
func (a *App) PlaceTicket(boardID string, id int64, status string, beforeID int64) (Ticket, error) {
	return a.store.PlaceTicket(boardID, id, status, beforeID)
}

func (a *App) EditComment(boardID string, ticketID, commentID int64, text string) (Ticket, error) {
	return a.store.EditComment(boardID, ticketID, commentID, text)
}

func (a *App) DeleteComment(boardID string, ticketID, commentID int64) (Ticket, error) {
	return a.store.DeleteComment(boardID, ticketID, commentID)
}

func (a *App) AddComment(boardID string, id int64, text string) (Ticket, error) {
	return a.store.AddComment(boardID, id, text)
}

func (a *App) DeleteTicket(boardID string, id int64) error {
	return a.store.DeleteTicket(boardID, id)
}

func (a *App) RestoreTicket(boardID string, id int64) (Ticket, error) {
	return a.store.RestoreTicket(boardID, id)
}

func (a *App) MoveTicketToBoard(fromBoardID string, id int64, toBoardID string) (Ticket, error) {
	return a.store.MoveTicketToBoard(fromBoardID, id, toBoardID)
}

// ---------- drafts ----------

func (a *App) GetDraft(key string) (*Draft, error) {
	return a.store.GetDraft(key)
}

func (a *App) ListDraftKeys() ([]string, error) {
	return a.store.DraftKeys()
}

func (a *App) SaveDraft(key string, fields map[string]string) error {
	return a.store.SaveDraft(key, fields)
}

func (a *App) DeleteDraft(key string) error {
	return a.store.DeleteDraft(key)
}
