package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Create an instance of the app structure
	app := NewApp()

	appMenu := menu.NewMenu()

	fileMenu := appMenu.AddSubmenu("File")
	fileMenu.AddText("New Ticket", nil, func(_ *menu.CallbackData) {
		runtime.EventsEmit(app.ctx, "openNewTicket")
	})

	toolsMenu := appMenu.AddSubmenu("Tools")
	toolsMenu.AddText("Deleted Tickets", nil, func(_ *menu.CallbackData) {
		runtime.EventsEmit(app.ctx, "openDeletedTickets")
	})
	toolsMenu.AddText("MCP", nil, func(_ *menu.CallbackData) {
		runtime.EventsEmit(app.ctx, "openMCPSettings")
	})

	helpMenu := appMenu.AddSubmenu("Help")
	helpMenu.AddText("Keyboard Shortcuts", nil, func(_ *menu.CallbackData) {
		runtime.EventsEmit(app.ctx, "openKeyboardShortcuts")
	})
	helpMenu.AddText("About", nil, func(_ *menu.CallbackData) {
		runtime.EventsEmit(app.ctx, "openAbout")
	})

	// Create application with options
	err := wails.Run(&options.App{
		Title:  "Tinier Todo",
		Width:  1024,
		Height: 768,
		Menu:   appMenu,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
