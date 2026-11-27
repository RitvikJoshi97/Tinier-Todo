package main

import (
	"embed"
	"log"
	goruntime "runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

// buildMenu builds the native menu bar. The Boards menu lists every board, so
// it is rebuilt whenever the boards change.
func (a *App) buildMenu() *menu.Menu {
	emit := func(event string, data ...interface{}) func(*menu.CallbackData) {
		return func(_ *menu.CallbackData) {
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, event, data...)
			}
		}
	}

	appMenu := menu.NewMenu()
	isMac := goruntime.GOOS == "darwin"
	if isMac {
		// macOS needs the application menu for Quit (⌘Q), Hide and About, and
		// the Edit menu for ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z to work in text fields.
		appMenu.Append(menu.AppMenu())
	}

	// Import and export work on the open board, and need the data folder.
	ifReady := func(action func()) func(*menu.CallbackData) {
		return func(_ *menu.CallbackData) {
			if a.ctx != nil && a.store != nil {
				go action()
			}
		}
	}

	fileMenu := appMenu.AddSubmenu("File")
	fileMenu.AddText("New Ticket", nil, emit("openNewTicket"))
	fileMenu.AddText("New Board…", nil, emit("openNewBoard"))
	fileMenu.AddSeparator()
	importMenu := fileMenu.AddSubmenu("Import")
	importMenu.AddText("Backup (.json)…", nil, ifReady(a.importBackup))
	importMenu.AddText("Tickets from CSV into This Board…", nil, ifReady(a.importCSV))
	exportMenu := fileMenu.AddSubmenu("Export")
	exportMenu.AddText("This Board as Markdown…", nil, ifReady(a.exportBoardMarkdown))
	exportMenu.AddText("This Board as CSV…", nil, ifReady(a.exportBoardCSV))
	exportMenu.AddSeparator()
	exportMenu.AddText("Backup of All Boards (.json)…", nil, ifReady(a.exportBackup))
	if !isMac {
		fileMenu.AddSeparator()
		quitLabel := "Quit"
		if goruntime.GOOS == "windows" {
			quitLabel = "Exit"
		}
		fileMenu.AddText(quitLabel, keys.CmdOrCtrl("q"), func(_ *menu.CallbackData) {
			if a.ctx != nil {
				runtime.Quit(a.ctx)
			}
		})
	}

	if isMac {
		appMenu.Append(menu.EditMenu())
	}

	boardsMenu := appMenu.AddSubmenu("Boards")
	// The store opens at start-up; until then the menu has no board list.
	if a.store != nil {
		if state, err := a.store.Boards(); err == nil {
			for _, board := range state.Boards {
				boardsMenu.AddRadio(board.Name, board.ID == state.ActiveBoardID, nil, emit("switchBoard", board.ID))
			}
			boardsMenu.AddSeparator()
		} else {
			log.Printf("Failed to list boards for the menu: %v", err)
		}
	}
	boardsMenu.AddText("New Board…", nil, emit("openNewBoard"))
	boardsMenu.AddText("Edit Columns…", nil, emit("openEditColumns"))
	boardsMenu.AddText("Manage Boards…", nil, emit("openManageBoards"))

	toolsMenu := appMenu.AddSubmenu("Tools")
	toolsMenu.AddText("Settings…", nil, emit("openSettings"))
	toolsMenu.AddText("Deleted Tickets", nil, emit("openDeletedTickets"))
	toolsMenu.AddText("MCP", nil, emit("openMCPSettings"))

	if isMac {
		appMenu.Append(menu.WindowMenu()) // Minimise (⌘M), Zoom, and the window list
	}

	helpMenu := appMenu.AddSubmenu("Help")
	helpMenu.AddText("Keyboard Shortcuts", nil, emit("openKeyboardShortcuts"))
	helpMenu.AddText("About", nil, emit("openAbout"))

	return appMenu
}

// RefreshMenu rebuilds the menu bar after the boards change.
func (a *App) RefreshMenu() {
	if a.ctx == nil {
		return
	}
	runtime.MenuSetApplicationMenu(a.ctx, a.buildMenu())
	runtime.MenuUpdateApplicationMenu(a.ctx)
}

func main() {
	app := NewApp()
	window := loadWindowState()

	err := wails.Run(&options.App{
		Title:     "Tinier Todo",
		Width:     window.Width,
		Height:    window.Height,
		MinWidth:  minWindowWidth,
		MinHeight: minWindowHeight,
		Menu:      app.buildMenu(),
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 247, G: 247, B: 248, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		OnBeforeClose:    app.beforeClose,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
