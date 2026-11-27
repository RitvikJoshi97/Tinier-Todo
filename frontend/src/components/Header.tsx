import React, { RefObject } from "react";
import { BoardSwitcher, Board } from "../boards/Boards";
import { HelpIcon, MicIcon, MoonIcon, PlusIcon, SearchIcon, SunIcon } from "../icons";
import { Filters } from "../lib/search";
import { isMac, shortcutText } from "../lib/platform";
import { FilterMenu, ProjectOption } from "./FilterMenu";

interface Props {
  boards: Board[];
  activeBoardId: string;
  onSwitchBoard: (id: string) => void;
  onNewBoard: () => void;
  onManageBoards: () => void;
  onEditColumns: () => void;
  searchOpen: boolean;
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement>;
  onSearchChange: (query: string) => void;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  filters: Filters;
  projects: ProjectOption[];
  onFiltersChange: (filters: Filters) => void;
  recording: boolean;
  onMic: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onHelp: () => void;
  hasNewDraft: boolean;
  onNewTicket: () => void;
}

export function Header(props: Props) {
  const micLabel = props.recording ? "Stop voice input (Space)" : `Voice input (${shortcutText("Shift", "N")})`;

  return (
    <header className="header">
      <div className="header-left">
        <div className="app-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1>Tinier Todo</h1>
        {props.boards.length > 0 && (
          <>
            <span className="header-divider" aria-hidden="true">
              /
            </span>
            <BoardSwitcher
              boards={props.boards}
              activeBoardId={props.activeBoardId}
              onSwitch={props.onSwitchBoard}
              onNewBoard={props.onNewBoard}
              onManage={props.onManageBoards}
              onEditColumns={props.onEditColumns}
            />
          </>
        )}
      </div>
      <div className="header-buttons">
        {props.searchOpen ? (
          <label className="search-field">
            <SearchIcon size={15} />
            <input
              ref={props.searchInputRef}
              autoFocus
              type="text"
              className="search-input"
              value={props.searchQuery}
              onChange={(e) => props.onSearchChange(e.target.value)}
              onBlur={() => {
                if (!props.searchQuery) props.onCloseSearch();
              }}
              placeholder="Search tickets"
              aria-label="Search tickets"
            />
            <kbd>Esc</kbd>
          </label>
        ) : (
          <button
            type="button"
            className="icon-button"
            title={`Search tickets (${shortcutText("F")})`}
            aria-label="Search tickets"
            onClick={props.onOpenSearch}
          >
            <SearchIcon />
          </button>
        )}
        <FilterMenu filters={props.filters} projects={props.projects} onChange={props.onFiltersChange} />
        <button
          id="micBtn"
          type="button"
          className={`icon-button mic-btn${props.recording ? " recording" : ""}`}
          aria-label={micLabel}
          title={micLabel}
          onClick={props.onMic}
        >
          <MicIcon />
          {props.recording && <span className="recording-label">Listening</span>}
        </button>
        <button
          id="darkModeToggle"
          type="button"
          className="icon-button"
          title={`${props.darkMode ? "Light" : "Dark"} mode (${shortcutText("D")})`}
          aria-label="Toggle dark mode"
          onClick={props.onToggleDarkMode}
        >
          {props.darkMode ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          type="button"
          className="icon-button"
          title={`Keyboard shortcuts (${shortcutText("/")})`}
          aria-label="Keyboard shortcuts"
          onClick={props.onHelp}
        >
          <HelpIcon />
        </button>
        <button
          id="newTicketBtn"
          type="button"
          className={`primary-button${props.hasNewDraft ? " has-draft" : ""}`}
          title={props.hasNewDraft ? "New ticket (you have an unsaved draft)" : `New ticket (${shortcutText("N")})`}
          onClick={props.onNewTicket}
        >
          <PlusIcon size={15} />
          New ticket
          <kbd>{isMac() ? "⌘N" : "Ctrl N"}</kbd>
          {props.hasNewDraft && <span className="draft-dot" aria-label="unsaved draft" />}
        </button>
      </div>
    </header>
  );
}
