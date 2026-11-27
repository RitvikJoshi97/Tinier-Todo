package main

import (
	"context"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// The window's size, position and maximised state are saved on close and
// restored on the next launch.

type WindowState struct {
	Width       int  `json:"width"`
	Height      int  `json:"height"`
	X           int  `json:"x"`
	Y           int  `json:"y"`
	HasPosition bool `json:"hasPosition"`
	Maximised   bool `json:"maximised"`
}

const (
	defaultWindowWidth  = 1100
	defaultWindowHeight = 760
	minWindowWidth      = 640
	minWindowHeight     = 480
)

func windowStatePath() string {
	dir, err := defaultDataDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "window.json")
}

// loadWindowState only reads: main() calls it before the app starts, and
// `wails build` runs main() too.
func loadWindowState() WindowState {
	state := WindowState{Width: defaultWindowWidth, Height: defaultWindowHeight}
	if path := windowStatePath(); path != "" {
		_ = readJSON(path, &state)
	}
	if state.Width < minWindowWidth || state.Height < minWindowHeight {
		state.Width, state.Height = defaultWindowWidth, defaultWindowHeight
	}
	return state
}

func (a *App) restoreWindowPosition(state WindowState) {
	width, height := currentScreenSize(a.ctx)
	if state.HasPosition && positionFits(state, width, height) {
		runtime.WindowSetPosition(a.ctx, state.X, state.Y)
	}
	if state.Maximised {
		runtime.WindowMaximise(a.ctx)
	}
}

// beforeClose saves the window state. Returning false lets the window close.
func (a *App) beforeClose(ctx context.Context) bool {
	path := windowStatePath()
	if path == "" || a.store == nil {
		return false
	}
	state := loadWindowState()
	state.Maximised = runtime.WindowIsMaximised(ctx)
	if !state.Maximised && !runtime.WindowIsMinimised(ctx) {
		// Keep the last normal size while maximised, so un-maximising next
		// time goes back to it.
		state.Width, state.Height = runtime.WindowGetSize(ctx)
		state.X, state.Y = runtime.WindowGetPosition(ctx)
		state.HasPosition = true
	}
	_ = writeJSONAtomic(path, state, false)
	return false
}

// currentScreenSize is the size of the screen the window opened on, or 0×0 if
// it isn't known.
func currentScreenSize(ctx context.Context) (int, int) {
	screens, err := runtime.ScreenGetAll(ctx)
	if err != nil {
		return 0, 0
	}
	for _, screen := range screens {
		if screen.IsCurrent {
			return screen.Size.Width, screen.Size.Height
		}
	}
	return 0, 0
}

// positionFits is false when the saved position would put the window's title
// bar off the screen, which happens on Windows after unplugging the monitor
// it was on (macOS moves such windows back by itself). Wails measures the
// position from the corner of the current screen. The window then opens in
// the middle of the screen instead.
func positionFits(state WindowState, screenWidth, screenHeight int) bool {
	if screenWidth <= 0 || screenHeight <= 0 {
		return true
	}
	const visible = 100 // pixels of the title bar that must be on screen
	return state.X > -state.Width+visible && state.X < screenWidth-visible &&
		state.Y >= 0 && state.Y < screenHeight-visible
}
