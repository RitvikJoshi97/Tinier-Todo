package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
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
}

func defaultMCPSettings() MCPSettings {
	return MCPSettings{
		Enabled: true,
		Port:    defaultMCPPort,
	}
}

func sanitizeMCPSettings(settings MCPSettings) MCPSettings {
	if settings.Port < 1 || settings.Port > 65535 {
		settings.Port = defaultMCPPort
	}

	return settings
}

func getMCPSettingsFilePath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	appDataDir := filepath.Join(homeDir, ".tinier-todo")
	if err := os.MkdirAll(appDataDir, 0755); err != nil {
		return "", err
	}

	return filepath.Join(appDataDir, "mcp_settings.json"), nil
}

func mcpBaseURL(port int) string {
	return fmt.Sprintf("http://localhost:%d", port)
}

func mcpSSEURL(port int) string {
	return fmt.Sprintf("%s/sse", mcpBaseURL(port))
}

func buildMCPConfigSnippet(port int) string {
	snippet, err := json.MarshalIndent(map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"tinier-todo": map[string]interface{}{
				"url": mcpSSEURL(port),
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
		"url":     mcpSSEURL(settings.Port),
		"snippet": buildMCPConfigSnippet(settings.Port),
	}
}

func (a *App) loadMCPSettings() (MCPSettings, error) {
	filePath, err := getMCPSettingsFilePath()
	if err != nil {
		return MCPSettings{}, err
	}

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return defaultMCPSettings(), nil
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return MCPSettings{}, err
	}

	var settings MCPSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return MCPSettings{}, err
	}

	return sanitizeMCPSettings(settings), nil
}

func (a *App) persistMCPSettings(settings MCPSettings) error {
	filePath, err := getMCPSettingsFilePath()
	if err != nil {
		return err
	}

	data, err := json.MarshalIndent(sanitizeMCPSettings(settings), "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filePath, data, 0644)
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

func (a *App) startMCPServerForSettings(settings MCPSettings) error {
	settings = sanitizeMCPSettings(settings)
	sseServer := newMCPServer(a, settings.Port)
	errCh := make(chan error, 1)

	a.mcpMu.Lock()
	a.mcpServer = sseServer
	a.mcpMu.Unlock()

	go func() {
		err := sseServer.Start(fmt.Sprintf("127.0.0.1:%d", settings.Port)) // loopback only: the MCP server has no authentication

		a.mcpMu.Lock()
		if a.mcpServer == sseServer {
			a.mcpServer = nil
		}
		a.mcpMu.Unlock()

		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("MCP server stopped: %v", err)
		}

		errCh <- err
	}()

	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-time.After(150 * time.Millisecond):
		log.Printf("MCP server listening on %s", mcpSSEURL(settings.Port))
		return nil
	}
}

func (a *App) stopMCPServer() error {
	a.mcpMu.Lock()
	sseServer := a.mcpServer
	a.mcpServer = nil
	a.mcpMu.Unlock()

	if sseServer == nil {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	err := sseServer.Shutdown(ctx)
	if errors.Is(err, http.ErrServerClosed) {
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
	settings := sanitizeMCPSettings(a.mcpSettings)
	if settings.Port == 0 {
		settings = defaultMCPSettings()
		a.mcpSettings = settings
	}
	a.mcpMu.Unlock()

	return buildMCPSettingsResponse(settings), nil
}

func (a *App) UpdateMCPSettings(enabled bool, port float64) (map[string]interface{}, error) {
	settings := MCPSettings{
		Enabled: enabled,
		Port:    int(port),
	}

	if err := a.applyMCPSettings(settings); err != nil {
		return nil, err
	}

	return a.GetMCPSettings()
}

func newMCPServer(app *App, port int) *server.SSEServer {
	s := server.NewMCPServer("tinier-todo", "1.0.0")

	s.AddTool(
		mcp.NewTool("list_tickets",
			mcp.WithDescription("List active tickets. Optionally filter by status or project."),
			mcp.WithString("status",
				mcp.Description("Filter by status: todo, inprogress, or done."),
				mcp.Enum("todo", "inprogress", "done"),
			),
			mcp.WithString("project",
				mcp.Description("Filter by project name (case-insensitive substring match)."),
			),
		),
		func(args map[string]interface{}) (*mcp.CallToolResult, error) {
			tickets, err := app.LoadTickets()
			if err != nil {
				return nil, err
			}

			status, _ := args["status"].(string)
			project, _ := args["project"].(string)

			var filtered []map[string]interface{}
			for _, ticket := range tickets {
				if status != "" && ticket["status"] != status {
					continue
				}

				if project != "" {
					ticketProject, _ := ticket["project"].(string)
					if !strings.Contains(strings.ToLower(ticketProject), strings.ToLower(project)) {
						continue
					}
				}

				filtered = append(filtered, ticket)
			}

			if filtered == nil {
				filtered = []map[string]interface{}{}
			}

			return mcp.NewToolResultText(toJSON(filtered)), nil
		},
	)

	s.AddTool(
		mcp.NewTool("create_ticket",
			mcp.WithDescription("Create a new ticket in Tinier Todo."),
			mcp.WithString("name", mcp.Description("Short title of the ticket."), mcp.Required()),
			mcp.WithString("description", mcp.Description("Detailed description."), mcp.Required()),
			mcp.WithString("project", mcp.Description("Project name."), mcp.Required()),
			mcp.WithString("link", mcp.Description("Optional URL reference.")),
			mcp.WithString("deadline", mcp.Description("Deadline in YYYY-MM-DD format.")),
			mcp.WithString("status",
				mcp.Description("Initial status. Defaults to 'todo'."),
				mcp.Enum("todo", "inprogress", "done"),
			),
		),
		func(args map[string]interface{}) (*mcp.CallToolResult, error) {
			name, _ := args["name"].(string)
			if strings.TrimSpace(name) == "" {
				return nil, fmt.Errorf("'name' is required")
			}

			description, _ := args["description"].(string)
			if strings.TrimSpace(description) == "" {
				return nil, fmt.Errorf("'description' is required")
			}

			project, _ := args["project"].(string)
			if strings.TrimSpace(project) == "" {
				return nil, fmt.Errorf("'project' is required")
			}

			status := strVal(args["status"], "todo")
			if !isValidStatus(status) {
				status = "todo"
			}

			ticket := map[string]interface{}{
				"id":          float64(time.Now().UnixMilli()),
				"name":        name,
				"description": description,
				"project":     project,
				"link":        strVal(args["link"], ""),
				"deadline":    strVal(args["deadline"], ""),
				"status":      status,
				"comments":    []interface{}{},
			}

			if err := app.CreateTicket(ticket); err != nil {
				return nil, err
			}

			return mcp.NewToolResultText("Ticket created:\n" + toJSON(ticket)), nil
		},
	)

	s.AddTool(
		mcp.NewTool("edit_ticket",
			mcp.WithDescription("Edit fields of an existing ticket by its numeric id."),
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
			mcp.WithString("name", mcp.Description("New title.")),
			mcp.WithString("description", mcp.Description("New description.")),
			mcp.WithString("project", mcp.Description("New project name.")),
			mcp.WithString("link", mcp.Description("New URL reference.")),
			mcp.WithString("deadline", mcp.Description("New deadline in YYYY-MM-DD format.")),
		),
		func(args map[string]interface{}) (*mcp.CallToolResult, error) {
			id, ok := args["id"].(float64)
			if !ok || id == 0 {
				return nil, fmt.Errorf("'id' is required")
			}

			updates := map[string]interface{}{}
			for _, field := range []string{"name", "description", "project", "link", "deadline"} {
				if value, exists := args[field]; exists {
					updates[field] = value
				}
			}

			if err := app.EditTicket(id, updates); err != nil {
				return nil, err
			}

			return mcp.NewToolResultText(fmt.Sprintf("Ticket %.0f updated.", id)), nil
		},
	)

	s.AddTool(
		mcp.NewTool("move_ticket",
			mcp.WithDescription("Move a ticket to a different status column."),
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
			mcp.WithString("status",
				mcp.Description("Target status: todo, inprogress, or done."),
				mcp.Enum("todo", "inprogress", "done"),
				mcp.Required(),
			),
		),
		func(args map[string]interface{}) (*mcp.CallToolResult, error) {
			id, ok := args["id"].(float64)
			if !ok || id == 0 {
				return nil, fmt.Errorf("'id' is required")
			}

			status, _ := args["status"].(string)
			if !isValidStatus(status) {
				return nil, fmt.Errorf("invalid status %q", status)
			}

			if err := app.MoveTicket(id, status); err != nil {
				return nil, err
			}

			return mcp.NewToolResultText(fmt.Sprintf("Ticket %.0f moved to '%s'.", id, status)), nil
		},
	)

	s.AddTool(
		mcp.NewTool("delete_ticket",
			mcp.WithDescription("Soft-delete a ticket (moves it to the deleted list)."),
			mcp.WithNumber("id", mcp.Description("Ticket id."), mcp.Required()),
		),
		func(args map[string]interface{}) (*mcp.CallToolResult, error) {
			id, ok := args["id"].(float64)
			if !ok || id == 0 {
				return nil, fmt.Errorf("'id' is required")
			}

			tickets, err := app.LoadTickets()
			if err != nil {
				return nil, err
			}

			idx := -1
			for i, ticket := range tickets {
				if ticketID, _ := ticket["id"].(float64); ticketID == id {
					idx = i
					break
				}
			}

			if idx == -1 {
				return nil, fmt.Errorf("ticket %.0f not found", id)
			}

			removed := tickets[idx]
			tickets = append(tickets[:idx], tickets[idx+1:]...)
			if err := app.SaveTickets(tickets); err != nil {
				return nil, err
			}

			deleted, _ := app.LoadDeletedTickets()
			removed["deletedAt"] = time.Now().UTC().Format(time.RFC3339)
			deleted = append(deleted, removed)
			if err := app.SaveDeletedTickets(deleted); err != nil {
				return nil, err
			}

			return mcp.NewToolResultText(fmt.Sprintf("Ticket %.0f deleted.", id)), nil
		},
	)

	s.AddTool(
		mcp.NewTool("list_deleted_tickets",
			mcp.WithDescription("List all soft-deleted tickets."),
		),
		func(args map[string]interface{}) (*mcp.CallToolResult, error) {
			deleted, err := app.LoadDeletedTickets()
			if err != nil {
				return nil, err
			}

			if len(deleted) == 0 {
				return mcp.NewToolResultText("No deleted tickets."), nil
			}

			return mcp.NewToolResultText(toJSON(deleted)), nil
		},
	)

	s.AddTool(
		mcp.NewTool("restore_ticket",
			mcp.WithDescription("Restore a soft-deleted ticket back to active tickets."),
			mcp.WithNumber("id", mcp.Description("Ticket id to restore."), mcp.Required()),
		),
		func(args map[string]interface{}) (*mcp.CallToolResult, error) {
			id, ok := args["id"].(float64)
			if !ok || id == 0 {
				return nil, fmt.Errorf("'id' is required")
			}

			deleted, err := app.LoadDeletedTickets()
			if err != nil {
				return nil, err
			}

			idx := -1
			for i, ticket := range deleted {
				if ticketID, _ := ticket["id"].(float64); ticketID == id {
					idx = i
					break
				}
			}

			if idx == -1 {
				return nil, fmt.Errorf("deleted ticket %.0f not found", id)
			}

			restored := deleted[idx]
			deleted = append(deleted[:idx], deleted[idx+1:]...)
			delete(restored, "deletedAt")

			if err := app.SaveDeletedTickets(deleted); err != nil {
				return nil, err
			}

			tickets, _ := app.LoadTickets()
			tickets = append(tickets, restored)
			if err := app.SaveTickets(tickets); err != nil {
				return nil, err
			}

			return mcp.NewToolResultText(fmt.Sprintf("Ticket %.0f restored.", id)), nil
		},
	)

	return server.NewSSEServer(s, mcpBaseURL(port))
}

func isValidStatus(status string) bool {
	return status == "todo" || status == "inprogress" || status == "done"
}

func strVal(value interface{}, defaultValue string) string {
	if text, ok := value.(string); ok {
		return text
	}

	return defaultValue
}

func toJSON(value interface{}) string {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Sprintf("%v", value)
	}

	return string(data)
}