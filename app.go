package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/server"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx         context.Context
	mcpMu       sync.Mutex
	mcpServer   *server.SSEServer
	mcpSettings MCPSettings
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.initializeMCP()
	a.startTicketFileWatcher()
}

func (a *App) startTicketFileWatcher() {
	ticketsPath, err := getDataFilePath()
	if err != nil {
		return
	}

	deletedPath, err := getDeletedDataFilePath()
	if err != nil {
		return
	}

	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()

		lastTicketsModTime := getFileModTime(ticketsPath)
		lastDeletedModTime := getFileModTime(deletedPath)

		for range ticker.C {
			currentTicketsModTime := getFileModTime(ticketsPath)
			currentDeletedModTime := getFileModTime(deletedPath)

			if currentTicketsModTime.Equal(lastTicketsModTime) && currentDeletedModTime.Equal(lastDeletedModTime) {
				continue
			}

			lastTicketsModTime = currentTicketsModTime
			lastDeletedModTime = currentDeletedModTime
			runtime.EventsEmit(a.ctx, "ticketsUpdated")
		}
	}()
}

func getFileModTime(filePath string) time.Time {
	info, err := os.Stat(filePath)
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

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
}

// getDataFilePath returns the path to the tickets data file
func getDataFilePath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	appDataDir := filepath.Join(homeDir, ".tinier-todo")

	// Create directory if it doesn't exist
	if err := os.MkdirAll(appDataDir, 0755); err != nil {
		return "", err
	}

	return filepath.Join(appDataDir, "tickets.json"), nil
}

// getDeletedDataFilePath returns the path to the deleted tickets data file
func getDeletedDataFilePath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	appDataDir := filepath.Join(homeDir, ".tinier-todo")

	// Create directory if it doesn't exist
	if err := os.MkdirAll(appDataDir, 0755); err != nil {
		return "", err
	}

	return filepath.Join(appDataDir, "deleted_tickets.json"), nil
}

func requireNonEmptyTicketField(ticket map[string]interface{}, fieldName string) error {
	value, ok := ticket[fieldName].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return fmt.Errorf("%q is required", fieldName)
	}

	return nil
}

func validateTicketCreateInput(ticket map[string]interface{}) error {
	for _, fieldName := range []string{"name", "description", "project"} {
		if err := requireNonEmptyTicketField(ticket, fieldName); err != nil {
			return err
		}
	}

	if status, ok := ticket["status"].(string); ok && status != "" {
		validStatuses := map[string]bool{"todo": true, "inprogress": true, "done": true}
		if !validStatuses[status] {
			return fmt.Errorf("invalid status %q: must be todo, inprogress, or done", status)
		}
	}

	return nil
}

func validateTicketUpdateInput(updates map[string]interface{}) error {
	for _, fieldName := range []string{"name", "description", "project"} {
		if value, exists := updates[fieldName]; exists {
			text, ok := value.(string)
			if !ok || strings.TrimSpace(text) == "" {
				return fmt.Errorf("%q cannot be empty", fieldName)
			}
		}
	}

	return nil
}

// SaveTickets saves tickets to a JSON file
func (a *App) SaveTickets(tickets []map[string]interface{}) error {
	filePath, err := getDataFilePath()
	if err != nil {
		return fmt.Errorf("failed to get data file path: %w", err)
	}

	data, err := json.MarshalIndent(tickets, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal tickets: %w", err)
	}

	if err := os.WriteFile(filePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write tickets file: %w", err)
	}

	return nil
}

// LoadTickets loads tickets from the JSON file
func (a *App) LoadTickets() ([]map[string]interface{}, error) {
	filePath, err := getDataFilePath()
	if err != nil {
		return []map[string]interface{}{}, fmt.Errorf("failed to get data file path: %w", err)
	}

	// If file doesn't exist, return empty list
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return []map[string]interface{}{}, nil
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return []map[string]interface{}{}, fmt.Errorf("failed to read tickets file: %w", err)
	}

	var tickets []map[string]interface{}
	if err := json.Unmarshal(data, &tickets); err != nil {
		return []map[string]interface{}{}, fmt.Errorf("failed to unmarshal tickets: %w", err)
	}

	return tickets, nil
}

// SaveDeletedTickets saves deleted tickets to a JSON file
func (a *App) SaveDeletedTickets(tickets []map[string]interface{}) error {
	filePath, err := getDeletedDataFilePath()
	if err != nil {
		return fmt.Errorf("failed to get deleted data file path: %w", err)
	}

	data, err := json.MarshalIndent(tickets, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal deleted tickets: %w", err)
	}

	if err := os.WriteFile(filePath, data, 0644); err != nil {
		return fmt.Errorf("failed to write deleted tickets file: %w", err)
	}

	return nil
}

// CreateTicket adds a new ticket and persists all tickets to disk.
func (a *App) CreateTicket(ticket map[string]interface{}) error {
	if err := validateTicketCreateInput(ticket); err != nil {
		return err
	}

	tickets, err := a.LoadTickets()
	if err != nil {
		return fmt.Errorf("failed to load tickets: %w", err)
	}
	tickets = append(tickets, ticket)
	return a.SaveTickets(tickets)
}

// EditTicket updates an existing ticket by its numeric id and persists changes.
// Only the fields present in updates are overwritten.
func (a *App) EditTicket(ticketId float64, updates map[string]interface{}) error {
	if err := validateTicketUpdateInput(updates); err != nil {
		return err
	}

	tickets, err := a.LoadTickets()
	if err != nil {
		return fmt.Errorf("failed to load tickets: %w", err)
	}

	found := false
	for i, t := range tickets {
		id, ok := t["id"].(float64)
		if !ok {
			continue
		}
		if id == ticketId {
			for k, v := range updates {
				tickets[i][k] = v
			}
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("ticket with id %v not found", ticketId)
	}

	return a.SaveTickets(tickets)
}

// MoveTicket changes the status of a ticket identified by ticketId.
// Valid statuses are "todo", "inprogress", and "done".
func (a *App) MoveTicket(ticketId float64, newStatus string) error {
	validStatuses := map[string]bool{"todo": true, "inprogress": true, "done": true}
	if !validStatuses[newStatus] {
		return fmt.Errorf("invalid status %q: must be todo, inprogress, or done", newStatus)
	}

	tickets, err := a.LoadTickets()
	if err != nil {
		return fmt.Errorf("failed to load tickets: %w", err)
	}

	found := false
	for i, t := range tickets {
		id, ok := t["id"].(float64)
		if !ok {
			continue
		}
		if id == ticketId {
			tickets[i]["status"] = newStatus
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("ticket with id %v not found", ticketId)
	}

	return a.SaveTickets(tickets)
}

// LoadDeletedTickets loads deleted tickets from the JSON file
func (a *App) LoadDeletedTickets() ([]map[string]interface{}, error) {
	filePath, err := getDeletedDataFilePath()
	if err != nil {
		return []map[string]interface{}{}, fmt.Errorf("failed to get deleted data file path: %w", err)
	}

	// If file doesn't exist, return empty list
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return []map[string]interface{}{}, nil
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return []map[string]interface{}{}, fmt.Errorf("failed to read deleted tickets file: %w", err)
	}

	var tickets []map[string]interface{}
	if err := json.Unmarshal(data, &tickets); err != nil {
		return []map[string]interface{}{}, fmt.Errorf("failed to unmarshal deleted tickets: %w", err)
	}

	return tickets, nil
}
