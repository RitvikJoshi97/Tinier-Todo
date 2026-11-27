package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const defaultMCPPort = 3535

type MCPSettings struct {
	Enabled bool `json:"enabled"`
	Port    int  `json:"port"`
	// Token is the secret clients send as "Authorization: Bearer <token>".
	Token string `json:"token"`
}

// The server starts switched off; it's turned on under Tools → MCP.
func defaultMCPSettings() MCPSettings {
	return MCPSettings{
		Enabled: false,
		Port:    defaultMCPPort,
	}
}

func sanitizeMCPSettings(settings MCPSettings) MCPSettings {
	if settings.Port < 1 || settings.Port > 65535 {
		settings.Port = defaultMCPPort
	}
	if len(settings.Token) < 16 {
		settings.Token = newMCPToken()
	}

	return settings
}

func getMCPSettingsFilePath() (string, error) {
	dir, err := defaultDataDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return filepath.Join(dir, "mcp_settings.json"), nil
}

func mcpBaseURL(port int) string {
	return fmt.Sprintf("http://localhost:%d", port)
}

// mcpURL is the Streamable HTTP endpoint, the transport current MCP clients
// use.
func mcpURL(port int) string {
	return mcpBaseURL(port) + "/mcp"
}

// mcpSSEURL is the older SSE endpoint, kept for clients set up before
// Streamable HTTP was added.
func mcpSSEURL(port int) string {
	return mcpBaseURL(port) + "/sse"
}

func buildMCPConfigSnippet(port int, token string) string {
	snippet, err := json.MarshalIndent(map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"tinier-todo": map[string]interface{}{
				"type":    "http",
				"url":     mcpURL(port),
				"headers": map[string]string{"Authorization": "Bearer " + token},
			},
		},
	}, "", "  ")
	if err != nil {
		return ""
	}

	return string(snippet)
}

func buildMCPSettingsResponse(settings MCPSettings) map[string]interface{} {
	settings = sanitizeMCPSettings(settings)

	return map[string]interface{}{
		"enabled": settings.Enabled,
		"port":    settings.Port,
		"url":     mcpURL(settings.Port),
		"sseUrl":  mcpSSEURL(settings.Port),
		"token":   settings.Token,
		"snippet": buildMCPConfigSnippet(settings.Port, settings.Token),
		"command": fmt.Sprintf("claude mcp add --transport http tinier-todo %s --header \"Authorization: Bearer %s\"",
			mcpURL(settings.Port), settings.Token),
	}
}

func (a *App) loadMCPSettings() (MCPSettings, error) {
	filePath, err := getMCPSettingsFilePath()
	if err != nil {
		return MCPSettings{}, err
	}

	settings := defaultMCPSettings()
	if err := readJSON(filePath, &settings); err != nil {
		return MCPSettings{}, err
	}
	return sanitizeMCPSettings(settings), nil
}

func (a *App) persistMCPSettings(settings MCPSettings) error {
	filePath, err := getMCPSettingsFilePath()
	if err != nil {
		return err
	}
	return writeJSONAtomic(filePath, sanitizeMCPSettings(settings), false)
}

func (a *App) initializeMCP() {
	settings, err := a.loadMCPSettings()
	if err != nil {
		log.Printf("Failed to load MCP settings, using defaults: %v", err)
		settings = defaultMCPSettings()
	}

	settings = sanitizeMCPSettings(settings)

	a.mcpMu.Lock()
	a.mcpSettings = settings
	a.mcpMu.Unlock()

	if err := a.persistMCPSettings(settings); err != nil {
		log.Printf("Failed to persist MCP settings: %v", err)
	}

	if settings.Enabled {
		if err := a.startMCPServerForSettings(settings); err != nil {
			log.Printf("Failed to start MCP server: %v", err)
		}
	}
}

// localOnly protects the server from web pages open in a browser on this
// machine (on top of the token, which a page wouldn't know):
//   - A Host header other than localhost means DNS rebinding: a site pointed
//     its own domain at 127.0.0.1 to get around the browser's same-origin rule.
//   - An Origin header from anywhere but localhost means a web page sent the
//     request. MCP clients are not browsers and send no Origin, and a browser
//     delivers a "simple" cross-origin POST even though the page cannot read
//     the reply, which would be enough to call a tool.
func localOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackHost(r.Host) {
			http.Error(w, "Forbidden: invalid Host header", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !isLoopbackOrigin(origin) {
			http.Error(w, "Forbidden: browser requests are not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLoopbackHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isLoopbackOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	return isLoopbackHost(parsed.Host)
}

func newMCPHTTPHandler(app *App, port int) (*mcpHTTPServer, http.Handler) {
	mcpServer := newMCPServer(app)
	// A ?token= given to /sse is passed on to the message endpoint it hands out.
	sse := server.NewSSEServer(mcpServer, server.WithBaseURL(mcpBaseURL(port)), server.WithAppendQueryToMessageEndpoint())
	streamable := server.NewStreamableHTTPServer(mcpServer)

	mux := http.NewServeMux()
	mux.Handle("/mcp", streamable)
	mux.Handle("/sse", sse)
	mux.Handle("/message", sse)

	return &mcpHTTPServer{sse: sse, streamable: streamable}, localOnly(requireToken(app.mcpToken, mux))
}

func (a *App) startMCPServerForSettings(settings MCPSettings) error {
	settings = sanitizeMCPSettings(settings)

	// Loopback only, and every request needs the token. "localhost" can
	// resolve to ::1 before 127.0.0.1 (macOS, Windows and many Linux setups
	// do), and some clients don't fall back, so listen on both when IPv6 is
	// available.
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", settings.Port))
	if err != nil {
		return err
	}
	listeners := []net.Listener{listener}
	if v6, err := net.Listen("tcp", fmt.Sprintf("[::1]:%d", settings.Port)); err == nil {
		listeners = append(listeners, v6)
	}

	servers, handler := newMCPHTTPHandler(a, settings.Port)
	httpServer := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	servers.stop = func(ctx context.Context) error {
		_ = servers.sse.Shutdown(ctx)
		_ = servers.streamable.Shutdown(ctx)
		return httpServer.Shutdown(ctx)
	}

	a.mcpMu.Lock()
	a.mcpHTTP = servers
	a.mcpMu.Unlock()

	for _, l := range listeners {
		go func(l net.Listener) {
			err := httpServer.Serve(l)
			a.mcpMu.Lock()
			if a.mcpHTTP == servers {
				a.mcpHTTP = nil
			}
			a.mcpMu.Unlock()
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("MCP server stopped: %v", err)
			}
		}(l)
	}

	log.Printf("MCP server listening on %s", mcpURL(settings.Port))
	return nil
}

func (a *App) stopMCPServer() error {
	a.mcpMu.Lock()
	servers := a.mcpHTTP
	a.mcpHTTP = nil
	a.mcpMu.Unlock()

	if servers == nil || servers.stop == nil {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := servers.stop(ctx)
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, context.DeadlineExceeded) {
		return nil
	}
	return err
}

func (a *App) applyMCPSettings(settings MCPSettings) error {
	settings = sanitizeMCPSettings(settings)

	a.mcpMu.Lock()
	previousSettings := a.mcpSettings
	a.mcpMu.Unlock()

	if err := a.stopMCPServer(); err != nil {
		return err
	}

	if settings.Enabled {
		if err := a.startMCPServerForSettings(settings); err != nil {
			if previousSettings.Enabled {
				if restartErr := a.startMCPServerForSettings(previousSettings); restartErr != nil {
					log.Printf("Failed to restore previous MCP server after error: %v", restartErr)
				}
			}

			return err
		}
	}

	a.mcpMu.Lock()
	a.mcpSettings = settings
	a.mcpMu.Unlock()

	if err := a.persistMCPSettings(settings); err != nil {
		return err
	}

	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, "mcpSettingsUpdated", buildMCPSettingsResponse(settings))
	}

	return nil
}

func (a *App) GetMCPSettings() (map[string]interface{}, error) {
	a.mcpMu.Lock()
	// Keep what sanitizing fills in, so the token doesn't change between calls.
	a.mcpSettings = sanitizeMCPSettings(a.mcpSettings)
	settings := a.mcpSettings
	a.mcpMu.Unlock()

	return buildMCPSettingsResponse(settings), nil
}

func (a *App) mcpToken() string {
	a.mcpMu.Lock()
	defer a.mcpMu.Unlock()
	return a.mcpSettings.Token
}

func (a *App) UpdateMCPSettings(enabled bool, port float64) (map[string]interface{}, error) {
	settings := MCPSettings{
		Enabled: enabled,
		Port:    int(port),
		Token:   a.mcpToken(),
	}

	if err := a.applyMCPSettings(settings); err != nil {
		return nil, err
	}

	return a.GetMCPSettings()
}

// RegenerateMCPToken replaces the MCP token, so clients set up with the old
// one stop working until they get the new one.
func (a *App) RegenerateMCPToken() (map[string]interface{}, error) {
	a.mcpMu.Lock()
	settings := a.mcpSettings
	a.mcpMu.Unlock()
	settings.Token = newMCPToken()
	if err := a.applyMCPSettings(settings); err != nil {
		return nil, err
	}
	return a.GetMCPSettings()
}

// ---------- tools ----------

var dueParam = mcp.WithString("due",
	mcp.Description("Filter by deadline: 'overdue', 'today', 'week' (due within 7 days, including "+
		"overdue ones still open) or 'none' (no deadline)."),
	mcp.Enum(dueFilters...),
)

var boardParam = mcp.WithString("board",
	mcp.Description("Board name or id. Defaults to the board open in the app."),
)

func ticketID(request mcp.CallToolRequest) (int64, error) {
	id := request.GetFloat("id", 0)
	if id <= 0 {
		return 0, errors.New("'id' is required")
	}
	return int64(id), nil
}

func optionalString(request mcp.CallToolRequest, key string) *string {
	if value, ok := request.GetArguments()[key].(string); ok {
		return &value
	}
	return nil
}

// Every tool works on this machine's boards only (no open world). Read tools
// change nothing; destructive ones can remove or move existing data.
func readTool(name string, opts ...mcp.ToolOption) mcp.Tool {
	return mcp.NewTool(name, append(opts, mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithDestructiveHintAnnotation(false), mcp.WithOpenWorldHintAnnotation(false))...)
}

func writeTool(name string, opts ...mcp.ToolOption) mcp.Tool {
	return mcp.NewTool(name, append(opts, mcp.WithDestructiveHintAnnotation(false),
		mcp.WithOpenWorldHintAnnotation(false))...)
}

func destructiveTool(name string, opts ...mcp.ToolOption) mcp.Tool {
	return mcp.NewTool(name, append(opts, mcp.WithOpenWorldHintAnnotation(false))...)
}

func toolError(err error) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultError(err.Error()), nil
}

func newMCPServer(app *App) *server.MCPServer {
	s := server.NewMCPServer("tinier-todo", version,
		server.WithToolCapabilities(false),
		server.WithInstructions("Tinier Todo is a Kanban board app. Tickets live on boards; each board "+
			"has its own columns, and a ticket's status is the column it is in (give a column's id "+
			"or name). list_boards shows every board's columns. Every ticket tool takes an optional 'board' "+
			"(name or id); without it, the board open in the app is used. Call list_boards to see "+
			"the boards, search_tickets to find tickets on any board (by text, project or deadline), and "+
			"get_ticket to read one ticket with its comments. Deadlines are YYYY-MM-DD."),
	)
	store := app.store

	s.AddTool(
		readTool("list_boards",
			mcp.WithDescription("List the boards, in the order shown in the app, with their columns and which one is open. "+
				"Columns marked done hold finished tickets."),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			state, err := store.Boards()
			if err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText(toJSON(state)), nil
		},
	)

	s.AddTool(
		writeTool("create_board",
			mcp.WithDescription("Create a new, empty board."),
			mcp.WithString("name", mcp.Description("Board name."), mcp.Required()),
			mcp.WithString("columns", mcp.Description("Optional comma-separated column names, in order, "+
				"e.g. 'Applied, Interviewing, Offer, Rejected'. Defaults to To Do, In Progress, Done.")),
			mcp.WithString("done_columns", mcp.Description("Optional comma-separated names of the columns "+
				"that hold finished tickets. Defaults to the last column.")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			name, err := request.RequireString("name")
			if err != nil {
				return toolError(err)
			}
			var columns []Column
			if names := splitList(request.GetString("columns", "")); len(names) > 0 {
				done := splitList(request.GetString("done_columns", ""))
				if len(done) == 0 {
					done = names[len(names)-1:]
				}
				columns = columnsFromNames(nil, names, done)
			}
			board, err := store.CreateBoardWithColumns(name, columns)
			if err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText("Board created:\n" + toJSON(board)), nil
		},
	)

	s.AddTool(
		destructiveTool("set_board_columns",
			mcp.WithDescription("Rename, add, remove or reorder a board's columns. Give every column, in order. "+
				"A column keeps its tickets when its name is unchanged; tickets of a removed column move to "+
				"the nearest remaining column before it."),
			boardParam,
			mcp.WithString("columns", mcp.Description("Comma-separated column names, in order."), mcp.Required()),
			mcp.WithString("done_columns", mcp.Description("Optional comma-separated names of the columns that "+
				"hold finished tickets. Without it, columns keep their current setting.")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			boardID, current, err := store.BoardColumns(request.GetString("board", ""))
			if err != nil {
				return toolError(err)
			}
			var done []string
			if request.GetString("done_columns", "") != "" {
				done = splitList(request.GetString("done_columns", ""))
			}
			board, err := store.SetBoardColumns(boardID, columnsFromNames(current, splitList(request.GetString("columns", "")), done))
			if err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText("Columns updated:\n" + toJSON(board)), nil
		},
	)

	s.AddTool(
		writeTool("rename_board",
			mcp.WithDescription("Rename a board."),
			mcp.WithString("board", mcp.Description("Current name or id of the board."), mcp.Required()),
			mcp.WithString("name", mcp.Description("New name."), mcp.Required()),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			name, err := request.RequireString("name")
			if err != nil {
				return toolError(err)
			}
			boardID, err := requiredBoard(store, request)
			if err != nil {
				return toolError(err)
			}
			if err := app.RenameBoard(boardID, name); err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText(fmt.Sprintf("Board renamed to %q.", strings.TrimSpace(name))), nil
		},
	)

	s.AddTool(
		destructiveTool("delete_board",
			mcp.WithDescription("Delete a board and all its tickets. The board's folder is moved to "+
				"~/.tinier-todo/trash/boards, so it can be recovered by hand, but it disappears from the app. "+
				"Only do this when the user asked for it. The last board can't be deleted."),
			mcp.WithString("board", mcp.Description("Name or id of the board."), mcp.Required()),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			boardID, err := requiredBoard(store, request)
			if err != nil {
				return toolError(err)
			}
			if err := app.DeleteBoard(boardID); err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText("Board deleted."), nil
		},
	)

	s.AddTool(
		writeTool("open_board",
			mcp.WithDescription("Show a board in the app. Ticket tools called without 'board' then use it."),
			mcp.WithString("board", mcp.Description("Name or id of the board."), mcp.Required()),
			mcp.WithIdempotentHintAnnotation(true),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			boardID, err := requiredBoard(store, request)
			if err != nil {
				return toolError(err)
			}
			if err := app.SetActiveBoard(boardID); err != nil {
				return toolError(err)
			}
			if app.ctx != nil {
				runtime.EventsEmit(app.ctx, "switchBoard", boardID)
			}
			return mcp.NewToolResultText("Board opened."), nil
		},
	)

	s.AddTool(
		readTool("board_markdown",
			mcp.WithDescription("A board as Markdown: one heading per column, its tickets as a task list "+
				"with deadlines, projects and descriptions. Handy for a quick overview or a status report."),
			boardParam,
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			md, err := store.BoardMarkdown(request.GetString("board", ""))
			if err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText(md), nil
		},
	)

	s.AddTool(
		readTool("list_tickets",
			mcp.WithDescription("List the active tickets of a board, in the order they appear in each column, "+
				"with each ticket's column name. Optionally filter by status, project or deadline."),
			boardParam,
			mcp.WithString("status", mcp.Description("Filter by column id or name.")),
			mcp.WithString("project", mcp.Description("Filter by project name (case-insensitive substring match).")),
			dueParam,
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tickets, err := store.FindTickets(TicketQuery{
				Board:   request.GetString("board", ""),
				Status:  request.GetString("status", ""),
				Project: request.GetString("project", ""),
				Due:     request.GetString("due", ""),
			}, time.Now())
			if err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText(toJSON(tickets)), nil
		},
	)

	s.AddTool(
		readTool("search_tickets",
			mcp.WithDescription("Find active tickets on every board (or one board). Every word of 'query' must "+
				"appear in the title, description, project or comments. Combine with status, project and due, "+
				"e.g. due='overdue' for everything late. Tickets in finished columns are left out unless "+
				"include_done is true. Results name each ticket's board and column."),
			mcp.WithString("query", mcp.Description("Words to look for (case-insensitive). Optional.")),
			mcp.WithString("board", mcp.Description("Board name or id to search. Defaults to every board.")),
			mcp.WithString("status", mcp.Description("Only tickets in the column with this name or id.")),
			mcp.WithString("project", mcp.Description("Project name (case-insensitive substring match).")),
			dueParam,
			mcp.WithBoolean("include_done", mcp.Description("Include tickets in finished columns. Default false.")),
			mcp.WithNumber("limit", mcp.Description("Maximum number of tickets to return. Default 50.")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			board := request.GetString("board", "")
			if board == "" {
				board = "*"
			}
			tickets, err := store.FindTickets(TicketQuery{
				Board:       board,
				Text:        request.GetString("query", ""),
				Status:      request.GetString("status", ""),
				Project:     request.GetString("project", ""),
				Due:         request.GetString("due", ""),
				ExcludeDone: !request.GetBool("include_done", false),
			}, time.Now())
			if err != nil {
				return toolError(err)
			}
			if len(tickets) == 0 {
				return mcp.NewToolResultText("No tickets match."), nil
			}
			limit := int(request.GetFloat("limit", 50))
			if limit <= 0 {
				limit = 50
			}
			if len(tickets) > limit {
				return mcp.NewToolResultText(fmt.Sprintf("%d tickets match; showing the first %d.\n%s",
					len(tickets), limit, toJSON(tickets[:limit]))), nil
			}
			return mcp.NewToolResultText(toJSON(tickets)), nil
		},
	)

	s.AddTool(
		readTool("get_ticket",
			mcp.WithDescription("Read one ticket, with its comments and the name of its column."),
			boardParam,
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			id, err := ticketID(request)
			if err != nil {
				return toolError(err)
			}
			ticket, err := store.GetTicket(request.GetString("board", ""), id)
			if err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText(toJSON(ticket)), nil
		},
	)

	s.AddTool(
		writeTool("create_ticket",
			mcp.WithDescription("Create a new ticket."),
			boardParam,
			mcp.WithString("name", mcp.Description("Short title of the ticket."), mcp.Required()),
			mcp.WithString("description", mcp.Description("Optional details. Markdown is supported.")),
			mcp.WithString("project", mcp.Description("Optional project name.")),
			mcp.WithString("link", mcp.Description("Optional URL reference.")),
			mcp.WithString("deadline", mcp.Description("Deadline in YYYY-MM-DD format.")),
			mcp.WithString("status",
				mcp.Description("Column id or name. Defaults to the board's first column."),
			),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			ticket, err := store.CreateTicket(request.GetString("board", ""), TicketFields{
				Name:        request.GetString("name", ""),
				Description: request.GetString("description", ""),
				Project:     request.GetString("project", ""),
				Link:        request.GetString("link", ""),
				Deadline:    request.GetString("deadline", ""),
				Status:      request.GetString("status", ""),
			})
			if err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText("Ticket created:\n" + toJSON(ticket)), nil
		},
	)

	s.AddTool(
		writeTool("edit_ticket",
			mcp.WithDescription("Edit fields of an existing ticket by its numeric id. Only the fields given are changed."),
			boardParam,
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
			mcp.WithString("name", mcp.Description("New title.")),
			mcp.WithString("description", mcp.Description("New description.")),
			mcp.WithString("project", mcp.Description("New project name.")),
			mcp.WithString("link", mcp.Description("New URL reference.")),
			mcp.WithString("deadline", mcp.Description("New deadline in YYYY-MM-DD format, or empty to clear it.")),
			mcp.WithString("status", mcp.Description("New column id or name. The ticket goes to the bottom of it.")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			id, err := ticketID(request)
			if err != nil {
				return toolError(err)
			}
			board := request.GetString("board", "")
			status := optionalString(request, "status")
			if status != nil {
				// Check the column first, so a bad status changes nothing.
				_, columns, err := store.BoardColumns(board)
				if err != nil {
					return toolError(err)
				}
				if _, ok := resolveStatus(columns, *status); !ok {
					return toolError(invalidStatusError(columns, *status))
				}
			}
			ticket, err := store.PatchTicket(board, id, TicketPatch{
				Name:        optionalString(request, "name"),
				Description: optionalString(request, "description"),
				Project:     optionalString(request, "project"),
				Link:        optionalString(request, "link"),
				Deadline:    optionalString(request, "deadline"),
			})
			if err != nil {
				return toolError(err)
			}
			if status != nil {
				// MoveTicket puts a ticket that changes column at the bottom of it.
				if ticket, err = store.MoveTicket(board, id, *status); err != nil {
					return toolError(err)
				}
			}
			return mcp.NewToolResultText("Ticket updated:\n" + toJSON(ticket)), nil
		},
	)

	s.AddTool(
		writeTool("move_ticket",
			mcp.WithDescription("Move a ticket to a status column, or reorder it within its column. "+
				"Tickets are listed in the order they appear in each column."),
			boardParam,
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
			mcp.WithString("status",
				mcp.Description("Target column id or name."),
				mcp.Required(),
			),
			mcp.WithNumber("before_id",
				mcp.Description("Optional id of a ticket in the target column to place this one above. "+
					"Without it, a ticket that changes column goes to the bottom."),
			),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			id, err := ticketID(request)
			if err != nil {
				return toolError(err)
			}
			status := request.GetString("status", "")
			board := request.GetString("board", "")
			var moved Ticket
			var err2 error
			if beforeID := int64(request.GetFloat("before_id", 0)); beforeID != 0 {
				moved, err2 = store.PlaceTicket(board, id, status, beforeID)
			} else {
				moved, err2 = store.MoveTicket(board, id, status)
			}
			if err2 != nil {
				return toolError(err2)
			}
			column := moved.Status
			if _, columns, err := store.BoardColumns(board); err == nil {
				column = columnName(columns, moved.Status)
			}
			return mcp.NewToolResultText(fmt.Sprintf("Ticket %d moved to '%s'.", id, column)), nil
		},
	)

	s.AddTool(
		writeTool("move_ticket_to_board",
			mcp.WithDescription("Move a ticket, with its comments, to another board."),
			boardParam,
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
			mcp.WithString("to_board", mcp.Description("Name or id of the board to move it to."), mcp.Required()),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			id, err := ticketID(request)
			if err != nil {
				return toolError(err)
			}
			toBoard, err := request.RequireString("to_board")
			if err != nil {
				return toolError(err)
			}
			ticket, err := store.MoveTicketToBoard(request.GetString("board", ""), id, toBoard)
			if err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText("Ticket moved:\n" + toJSON(ticket)), nil
		},
	)

	s.AddTool(
		writeTool("add_comment",
			mcp.WithDescription("Add a comment to a ticket."),
			boardParam,
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
			mcp.WithString("text", mcp.Description("Comment text."), mcp.Required()),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			id, err := ticketID(request)
			if err != nil {
				return toolError(err)
			}
			text, err := request.RequireString("text")
			if err != nil {
				return toolError(err)
			}
			if _, err := store.AddComment(request.GetString("board", ""), id, text); err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText(fmt.Sprintf("Comment added to ticket %d.", id)), nil
		},
	)

	s.AddTool(
		writeTool("edit_comment",
			mcp.WithDescription("Change the text of a comment. Comment ids are listed with each ticket."),
			boardParam,
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
			mcp.WithNumber("comment_id", mcp.Description("Comment id."), mcp.Required()),
			mcp.WithString("text", mcp.Description("New comment text."), mcp.Required()),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			id, err := ticketID(request)
			if err != nil {
				return toolError(err)
			}
			text, err := request.RequireString("text")
			if err != nil {
				return toolError(err)
			}
			commentID := int64(request.GetFloat("comment_id", 0))
			if _, err := store.EditComment(request.GetString("board", ""), id, commentID, text); err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText(fmt.Sprintf("Comment %d on ticket %d updated.", commentID, id)), nil
		},
	)

	s.AddTool(
		destructiveTool("delete_comment",
			mcp.WithDescription("Delete a comment from a ticket."),
			boardParam,
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
			mcp.WithNumber("comment_id", mcp.Description("Comment id."), mcp.Required()),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			id, err := ticketID(request)
			if err != nil {
				return toolError(err)
			}
			commentID := int64(request.GetFloat("comment_id", 0))
			if _, err := store.DeleteComment(request.GetString("board", ""), id, commentID); err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText(fmt.Sprintf("Comment %d deleted from ticket %d.", commentID, id)), nil
		},
	)

	s.AddTool(
		destructiveTool("delete_ticket",
			mcp.WithDescription("Soft-delete a ticket (moves it to the board's deleted list)."),
			boardParam,
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			id, err := ticketID(request)
			if err != nil {
				return toolError(err)
			}
			if err := store.DeleteTicket(request.GetString("board", ""), id); err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText(fmt.Sprintf("Ticket %d deleted.", id)), nil
		},
	)

	s.AddTool(
		readTool("list_deleted_tickets",
			mcp.WithDescription("List the soft-deleted tickets of a board."),
			boardParam,
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			deleted, err := store.DeletedTickets(request.GetString("board", ""))
			if err != nil {
				return toolError(err)
			}
			if len(deleted) == 0 {
				return mcp.NewToolResultText("No deleted tickets."), nil
			}
			return mcp.NewToolResultText(toJSON(deleted)), nil
		},
	)

	s.AddTool(
		writeTool("restore_ticket",
			mcp.WithDescription("Restore a soft-deleted ticket back onto its board."),
			boardParam,
			mcp.WithNumber("id", mcp.Description("Ticket id to restore."), mcp.Required()),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			id, err := ticketID(request)
			if err != nil {
				return toolError(err)
			}
			ticket, err := store.RestoreTicket(request.GetString("board", ""), id)
			if err != nil {
				return toolError(err)
			}
			return mcp.NewToolResultText(fmt.Sprintf("Ticket %d restored.", ticket.ID)), nil
		},
	)

	return s
}

func toJSON(value interface{}) string {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Sprintf("%v", value)
	}

	return string(data)
}

// requiredBoard resolves the required 'board' argument of board tools.
func requiredBoard(store *Store, request mcp.CallToolRequest) (string, error) {
	ref := strings.TrimSpace(request.GetString("board", ""))
	if ref == "" {
		return "", errors.New("'board' is required")
	}
	return store.ResolveBoard(ref)
}

// columnName is the name of the column with the given id.
func columnName(columns []Column, id string) string {
	for _, column := range columns {
		if column.ID == id {
			return column.Name
		}
	}
	return id
}

// splitList splits a comma-separated list and drops empty items.
func splitList(value string) []string {
	var items []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}
