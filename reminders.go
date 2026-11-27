package main

import (
	"fmt"
	"log"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/gen2brain/beeep"
)

// Deadline reminders: while the app is running, it shows a system
// notification for tickets that are due today or overdue, once a day per
// ticket, from the hour set in Settings (9:00 by default).

type ReminderSettings struct {
	Enabled bool `json:"enabled"`
	Hour    int  `json:"hour"`
}

type Settings struct {
	Reminders ReminderSettings `json:"reminders"`
}

func defaultSettings() Settings {
	return Settings{Reminders: ReminderSettings{Enabled: true, Hour: 9}}
}

func (s *Store) settingsPath() string    { return filepath.Join(s.dir, "settings.json") }
func (s *Store) reminderLogPath() string { return filepath.Join(s.dir, "reminders.json") }

func (s *Store) Settings() (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	settings := defaultSettings()
	if err := readJSON(s.settingsPath(), &settings); err != nil {
		return defaultSettings(), err
	}
	return sanitizeSettings(settings), nil
}

func (s *Store) SaveSettings(settings Settings) (Settings, error) {
	settings = sanitizeSettings(settings)
	s.mu.Lock()
	defer s.mu.Unlock()
	return settings, writeJSONAtomic(s.settingsPath(), settings, false)
}

func sanitizeSettings(settings Settings) Settings {
	if settings.Reminders.Hour < 0 || settings.Reminders.Hour > 23 {
		settings.Reminders.Hour = 9
	}
	return settings
}

type dueTicket struct {
	BoardID   string
	BoardName string
	Ticket    Ticket
	Overdue   bool
}

func reminderKey(boardID string, ticketID int64) string {
	return fmt.Sprintf("%s:%d", boardID, ticketID)
}

// pendingReminders returns the tickets to remind about now: not done, due
// today or earlier, and not already reminded about today. It returns nothing
// before the reminder hour.
func (s *Store) pendingReminders(now time.Time, hour int) ([]dueTicket, error) {
	if now.Hour() < hour {
		return nil, nil
	}
	today := now.Format("2006-01-02")

	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.readBoards()
	if err != nil {
		return nil, err
	}
	sent := map[string]string{}
	if err := readJSON(s.reminderLogPath(), &sent); err != nil {
		return nil, err
	}

	var due []dueTicket
	for _, board := range state.Boards {
		tickets, err := readTickets(s.ticketsPath(board.ID))
		if err != nil {
			continue
		}
		normalizeStatuses(tickets, board.Columns)
		for _, ticket := range tickets {
			if isDoneStatus(board.Columns, ticket.Status) || ticket.Deadline == "" || ticket.Deadline > today {
				continue
			}
			if sent[reminderKey(board.ID, ticket.ID)] == today {
				continue
			}
			due = append(due, dueTicket{
				BoardID:   board.ID,
				BoardName: board.Name,
				Ticket:    ticket,
				Overdue:   ticket.Deadline < today,
			})
		}
	}
	// Most overdue first.
	sort.SliceStable(due, func(i, j int) bool { return due[i].Ticket.Deadline < due[j].Ticket.Deadline })
	return due, nil
}

// markReminded records today's reminders and forgets entries older than a
// month.
func (s *Store) markReminded(items []dueTicket, now time.Time) error {
	today := now.Format("2006-01-02")
	cutoff := now.AddDate(0, -1, 0).Format("2006-01-02")

	s.mu.Lock()
	defer s.mu.Unlock()
	sent := map[string]string{}
	if err := readJSON(s.reminderLogPath(), &sent); err != nil {
		sent = map[string]string{}
	}
	for key, day := range sent {
		if day < cutoff {
			delete(sent, key)
		}
	}
	for _, item := range items {
		sent[reminderKey(item.BoardID, item.Ticket.ID)] = today
	}
	return writeJSONAtomic(s.reminderLogPath(), sent, false)
}

// reminderMessage turns the due tickets into one notification.
func reminderMessage(items []dueTicket, showBoard bool) (string, string) {
	label := func(item dueTicket) string {
		if showBoard {
			return fmt.Sprintf("%s (%s)", oneLine(item.Ticket.Name), item.BoardName)
		}
		return oneLine(item.Ticket.Name)
	}

	if len(items) == 1 {
		title := "Due today"
		if items[0].Overdue {
			title = "Overdue since " + items[0].Ticket.Deadline
		}
		return title, label(items[0])
	}

	overdue := 0
	for _, item := range items {
		if item.Overdue {
			overdue++
		}
	}
	var parts []string
	if overdue > 0 {
		parts = append(parts, fmt.Sprintf("%d overdue", overdue))
	}
	if dueToday := len(items) - overdue; dueToday > 0 {
		parts = append(parts, fmt.Sprintf("%d due today", dueToday))
	}
	names := make([]string, 0, 3)
	for i, item := range items {
		if i == 3 {
			names = append(names, fmt.Sprintf("and %d more", len(items)-3))
			break
		}
		names = append(names, label(item))
	}
	return fmt.Sprintf("%d tickets need attention", len(items)),
		strings.Join(parts, ", ") + ": " + strings.Join(names, ", ")
}

// notify shows a system notification. It is a variable so tests can
// replace it.
var notify = func(title, message string) error {
	return beeep.Notify(title, message, "")
}

func (a *App) checkReminders(now time.Time) {
	settings, err := a.store.Settings()
	if err != nil || !settings.Reminders.Enabled {
		return
	}
	items, err := a.store.pendingReminders(now, settings.Reminders.Hour)
	if err != nil || len(items) == 0 {
		return
	}
	state, _ := a.store.Boards()
	title, message := reminderMessage(items, len(state.Boards) > 1)
	if err := notify(title, message); err != nil {
		log.Printf("Failed to show reminder: %v", err)
		return
	}
	if err := a.store.markReminded(items, now); err != nil {
		log.Printf("Failed to record reminders: %v", err)
	}
}

func (a *App) startReminders() {
	beeep.AppName = "Tinier Todo"
	go func() {
		// Give the window a moment to appear before the first check.
		time.Sleep(5 * time.Second)
		a.checkReminders(time.Now())
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for now := range ticker.C {
			a.checkReminders(now)
		}
	}()
}

// ---------- bindings ----------

func (a *App) GetSettings() (Settings, error) {
	return a.store.Settings()
}

func (a *App) SaveSettings(settings Settings) (Settings, error) {
	saved, err := a.store.SaveSettings(settings)
	if err == nil {
		go a.checkReminders(time.Now())
	}
	return saved, err
}

// SendTestReminder shows a sample notification, so people can check that
// notifications are allowed for the app.
func (a *App) SendTestReminder() error {
	return notify("Tinier Todo", "Reminders are working. You'll be told about tickets due today or overdue.")
}
