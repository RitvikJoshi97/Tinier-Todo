import React, {
  useState,
  useRef,
  useLayoutEffect,
  useCallback,
  useEffect,
  useMemo,
} from "react";
import "./App.css";
import TicketDetails, { Ticket } from "./ticketDetails/TicketDetails";
import { EventsOn } from "../wailsjs/runtime/runtime";
import {
  GetMCPSettings,
  GetVersion,
  SaveTickets,
  LoadTickets,
  SaveDeletedTickets,
  LoadDeletedTickets,
  UpdateMCPSettings,
} from "../wailsjs/go/main/App";

const initialTickets: Ticket[] = [];
type DeletedTicket = Ticket & { deletedAt: string };
type MCPSettingsForm = { enabled: boolean; port: string };
const STATUSES: Ticket["status"][] = ["todo", "inprogress", "done"];
const DOUBLE_TAB_THRESHOLD = 300; // ms
const DEFAULT_MCP_PORT = 3535;

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function getSubsequenceScore(query: string, text: string): number {
  let queryIndex = 0;
  let score = 0;
  let consecutiveMatches = 0;

  for (let textIndex = 0; textIndex < text.length; textIndex++) {
    if (text[textIndex] !== query[queryIndex]) {
      consecutiveMatches = 0;
      continue;
    }

    score += consecutiveMatches > 0 ? 18 : 10;
    if (textIndex === queryIndex) {
      score += 8;
    }
    consecutiveMatches += 1;
    queryIndex += 1;

    if (queryIndex === query.length) {
      return score;
    }
  }

  return 0;
}

function getTicketSearchScore(ticket: Ticket, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return 1;
  }

  const searchableText = normalizeSearchText(
    [
      ticket.name,
      ticket.description,
      ticket.project,
      ticket.deadline,
      ticket.link ?? "",
      ticket.status,
      ...(ticket.comments?.map((comment) => comment.text) ?? []),
    ].join(" "),
  );

  if (!searchableText) {
    return 0;
  }

  if (searchableText.includes(normalizedQuery)) {
    return 1000 - searchableText.indexOf(normalizedQuery);
  }

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  let totalScore = 0;

  for (const token of queryTokens) {
    if (searchableText.includes(token)) {
      totalScore += 240 - searchableText.indexOf(token);
      continue;
    }

    const subsequenceScore = getSubsequenceScore(token, searchableText);
    if (subsequenceScore === 0) {
      return 0;
    }
    totalScore += subsequenceScore;
  }

  return totalScore;
}

function buildMCPConfigSnippet(port: number): string {
  return JSON.stringify(
    {
      mcpServers: {
        "tinier-todo": {
          url: `http://localhost:${port}/sse`,
        },
      },
    },
    null,
    2,
  );
}

function normalizeMCPSettingsForm(
  settings?: Record<string, any>,
): MCPSettingsForm {
  return {
    enabled: typeof settings?.enabled === "boolean" ? settings.enabled : true,
    port:
      typeof settings?.port === "number"
        ? String(settings.port)
        : String(DEFAULT_MCP_PORT),
  };
}

function getProjectTicketStyle(
  projectName: string,
  isDarkMode: boolean,
): React.CSSProperties {
  const normalized = projectName.trim().toLowerCase();
  if (!normalized) return {};

  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = normalized.charCodeAt(i) + ((hash << 5) - hash);
  }

  const hue = Math.abs(hash) % 360;

  if (isDarkMode) {
    return {
      backgroundColor: `hsl(${hue}, 22%, 28%)`,
      borderLeft: `4px solid hsl(${hue}, 45%, 60%)`,
    };
  }

  return {
    backgroundColor: `hsl(${hue}, 65%, 94%)`,
    borderLeft: `4px solid hsl(${hue}, 55%, 72%)`,
  };
}

function App() {
  const [tickets, setTickets] = useState<Ticket[]>(initialTickets);
  const [deletedTickets, setDeletedTickets] = useState<DeletedTicket[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showDeletedTicketsModal, setShowDeletedTicketsModal] = useState(false);
  const [showMCPModal, setShowMCPModal] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [editingTicketId, setEditingTicketId] = useState<number | null>(null);
  const [darkMode, setDarkMode] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    project: "",
    link: "",
    deadline: "",
    status: "todo",
  });
  const [comment, setComment] = useState("");

  // Speech recognition state
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<any>(null);
  const transcriptBufferRef = useRef("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Track which ticket is animating in (entering)
  const [enteringTicketId, setEnteringTicketId] = useState<number | null>(null);

  // Drag-and-drop state
  const draggedTicketId = useRef<number | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<Ticket["status"] | null>(
    null,
  );

  // Keyboard navigation state
  const [focusedColumnIdx, setFocusedColumnIdx] = useState(0);
  const [focusedTicketIdx, setFocusedTicketIdx] = useState(-1);
  const lastTabTime = useRef(0);

  // Help overlay
  const [showHelp, setShowHelp] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    GetVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);
  const [confirmDeleteTicket, setConfirmDeleteTicket] = useState<Ticket | null>(null);
  const [hasLoadedTickets, setHasLoadedTickets] = useState(false);
  const [hasLoadedDeletedTickets, setHasLoadedDeletedTickets] = useState(false);
  const [mcpSettingsForm, setMCPSettingsForm] = useState<MCPSettingsForm>({
    enabled: true,
    port: String(DEFAULT_MCP_PORT),
  });
  const [mcpSettingsFeedback, setMCPSettingsFeedback] = useState("");
  const [isSavingMCPSettings, setIsSavingMCPSettings] = useState(false);
  const skipNextStorageSaveRef = useRef({
    tickets: false,
    deletedTickets: false,
  });

  const parsedMCPPort = Number.parseInt(mcpSettingsForm.port, 10);
  const effectiveMCPPort =
    Number.isFinite(parsedMCPPort) && parsedMCPPort > 0 && parsedMCPPort <= 65535
      ? parsedMCPPort
      : DEFAULT_MCP_PORT;
  const mcpURL = `http://localhost:${effectiveMCPPort}/sse`;
  const mcpSnippet = useMemo(
    () => buildMCPConfigSnippet(effectiveMCPPort),
    [effectiveMCPPort],
  );

  const projectSuggestions = useMemo(() => {
    const uniqueProjects = new Map<string, string>();
    tickets.forEach((ticket) => {
      const raw = ticket.project?.trim();
      if (!raw) return;
      const key = raw.toLowerCase();
      if (!uniqueProjects.has(key)) {
        uniqueProjects.set(key, raw);
      }
    });

    return Array.from(uniqueProjects.values()).sort((a, b) =>
      a.localeCompare(b),
    );
  }, [tickets]);

  const normalizedSearchQuery = useMemo(
    () => normalizeSearchText(searchQuery),
    [searchQuery],
  );

  const filteredTickets = useMemo(() => {
    if (!normalizedSearchQuery) {
      return tickets;
    }

    return tickets.filter(
      (ticket) => getTicketSearchScore(ticket, normalizedSearchQuery) > 0,
    );
  }, [normalizedSearchQuery, tickets]);

  const isSearchActive = normalizedSearchQuery.length > 0;

  const syncTicketsFromStorage = useCallback(async () => {
    try {
      const loadedTickets = ((await LoadTickets()) as Ticket[]) || [];

      setTickets((prev) => {
        if (JSON.stringify(prev) === JSON.stringify(loadedTickets)) {
          return prev;
        }

        skipNextStorageSaveRef.current.tickets = true;
        return loadedTickets;
      });

      setSelectedTicket((prev) => {
        if (!prev) return prev;

        const updatedSelectedTicket =
          loadedTickets.find((ticket) => ticket.id === prev.id) ?? null;

        if (!updatedSelectedTicket) {
          setShowDetailsModal(false);
        }

        return updatedSelectedTicket;
      });

      setHasLoadedTickets(true);
    } catch (error) {
      console.error("Failed to load tickets:", error);
      setHasLoadedTickets(true);
    }

    try {
      const loadedDeletedTickets =
        ((await LoadDeletedTickets()) as DeletedTicket[]) || [];

      setDeletedTickets((prev) => {
        if (JSON.stringify(prev) === JSON.stringify(loadedDeletedTickets)) {
          return prev;
        }

        skipNextStorageSaveRef.current.deletedTickets = true;
        return loadedDeletedTickets;
      });

      setHasLoadedDeletedTickets(true);
    } catch (error) {
      console.error("Failed to load deleted tickets:", error);
      setHasLoadedDeletedTickets(true);
    }
  }, []);

  const loadMCPSettings = useCallback(async () => {
    try {
      const settings = (await GetMCPSettings()) as Record<string, any>;
      setMCPSettingsForm(normalizeMCPSettingsForm(settings));
      setMCPSettingsFeedback("");
    } catch (error) {
      console.error("Failed to load MCP settings:", error);
      setMCPSettingsFeedback("Failed to load MCP settings.");
    }
  }, []);

  // FLIP animation refs
  const ticketRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const prevRectsRef = useRef<Map<number, DOMRect>>(new Map());

  const capturePositions = useCallback(() => {
    const rects = new Map<number, DOMRect>();
    ticketRefs.current.forEach((el, id) => {
      if (el) rects.set(id, el.getBoundingClientRect());
    });
    prevRectsRef.current = rects;
  }, []);

  // FLIP animation effect
  useLayoutEffect(() => {
    const prevRects = prevRectsRef.current;
    if (prevRects.size === 0) return;

    ticketRefs.current.forEach((el, id) => {
      if (!el) return;
      const prevRect = prevRects.get(id);
      const currRect = el.getBoundingClientRect();
      if (!prevRect) return;

      const dx = prevRect.left - currRect.left;
      const dy = prevRect.top - currRect.top;

      if (dx === 0 && dy === 0) return;

      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.style.transition = "none";

      requestAnimationFrame(() => {
        el.style.transition = "transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)";
        el.style.transform = "";
        el.addEventListener(
          "transitionend",
          () => {
            el.style.transition = "";
          },
          { once: true },
        );
      });
    });

    prevRectsRef.current = new Map();
  }, [tickets]);

  // --- Drag-and-drop handlers ---
  const handleDragStart = (
    e: React.DragEvent<HTMLDivElement>,
    ticketId: number,
  ) => {
    draggedTicketId.current = ticketId;
    e.dataTransfer.effectAllowed = "move";
    // Make the dragged element semi-transparent after a frame
    const el = e.currentTarget;
    requestAnimationFrame(() => el.classList.add("dragging"));
  };

  const handleDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    e.currentTarget.classList.remove("dragging");
    draggedTicketId.current = null;
    setDragOverColumn(null);
  };

  const handleDragOver = (
    e: React.DragEvent<HTMLDivElement>,
    status: Ticket["status"],
  ) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverColumn(status);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Only clear if we actually left the column (not entered a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverColumn(null);
    }
  };

  const handleDrop = (
    e: React.DragEvent<HTMLDivElement>,
    newStatus: Ticket["status"],
  ) => {
    e.preventDefault();
    setDragOverColumn(null);

    const ticketId = draggedTicketId.current;
    if (ticketId == null) return;

    const ticket = tickets.find((t) => t.id === ticketId);
    if (!ticket || ticket.status === newStatus) return;

    // Capture positions before the change for FLIP
    capturePositions();

    setTickets((prev) =>
      prev.map((t) => (t.id === ticketId ? { ...t, status: newStatus } : t)),
    );

    // Update the selected ticket in the details modal too
    setSelectedTicket((prev) =>
      prev && prev.id === ticketId ? { ...prev, status: newStatus } : prev,
    );

    // Mark ticket as entering for pop-in animation
    setEnteringTicketId(ticketId);
    setTimeout(() => setEnteringTicketId(null), 400);
  };

  // Speech-to-text handlers
  const appendTranscriptToDescription = useCallback((transcript: string) => {
    const normalizedTranscript = transcript.trim();
    if (!normalizedTranscript) {
      return;
    }

    setForm((prev) => ({
      ...prev,
      description: [prev.description.trim(), normalizedTranscript]
        .filter(Boolean)
        .join(" "),
    }));
  }, []);

  const startRecording = useCallback(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert(
        "Speech Recognition not supported in your browser. Please use Chrome, Edge, or Safari."
      );
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    transcriptBufferRef.current = "";

    recognition.onstart = () => {
      setIsRecording(true);
    };

    recognition.onresult = (event: any) => {
      let nextInterimTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          appendTranscriptToDescription(transcript);
          transcriptBufferRef.current = "";
        } else {
          nextInterimTranscript += transcript;
        }
      }

      transcriptBufferRef.current = nextInterimTranscript;
    };

    recognition.onerror = (event: any) => {
      console.error("Speech recognition error", event.error);
      transcriptBufferRef.current = "";
      setIsRecording(false);
    };

    recognition.onend = () => {
      appendTranscriptToDescription(transcriptBufferRef.current);
      transcriptBufferRef.current = "";
      recognitionRef.current = null;
      setIsRecording(false);
    };

    recognition.start();
    recognitionRef.current = recognition;
  }, [appendTranscriptToDescription]);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    } else {
      appendTranscriptToDescription(transcriptBufferRef.current);
      transcriptBufferRef.current = "";
    }

    // Open New Ticket modal with current voice-captured form values preserved.
    setEditingTicketId(null);
    setShowDetailsModal(false);
    setShowModal(true);
    setFocusedTicketIdx(-1);
    setIsRecording(false);
  }, [appendTranscriptToDescription]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery("");
    setFocusedTicketIdx(-1);
  }, []);

  const handleSearchToggle = useCallback(() => {
    if (isSearchOpen) {
      closeSearch();
      return;
    }

    openSearch();
  }, [closeSearch, isSearchOpen, openSearch]);

  // Handle dark mode toggle
  const handleDarkModeToggle = useCallback(() => {
    setDarkMode((prev) => !prev);
    document.body.classList.toggle("dark-mode");
  }, []);

  // Handle modal open/close
  const openModal = useCallback(() => {
    setEditingTicketId(null);
    setForm({
      name: "",
      description: "",
      project: "",
      link: "",
      deadline: "",
      status: "todo",
    });
    setShowModal(true);
    // Clear keyboard focus when opening modal
    setFocusedTicketIdx(-1);
  }, []);
  const closeModal = useCallback(() => {
    setShowModal(false);
    setEditingTicketId(null);
    setForm({
      name: "",
      description: "",
      project: "",
      link: "",
      deadline: "",
      status: "todo",
    });
  }, []);

  const openDetailsModal = useCallback((ticket: Ticket) => {
    setSelectedTicket(ticket);
    setShowDetailsModal(true);
    setComment("");
    setFocusedTicketIdx(-1);
  }, []);

  const closeDetailsModal = useCallback(() => {
    setShowDetailsModal(false);
    setSelectedTicket(null);
    setComment("");
  }, []);

  const openDeletedTicketsModal = useCallback(() => {
    setShowDeletedTicketsModal(true);
    setFocusedTicketIdx(-1);
  }, []);

  const closeDeletedTicketsModal = useCallback(() => {
    setShowDeletedTicketsModal(false);
  }, []);

  const openMCPModal = useCallback(() => {
    setShowMCPModal(true);
    setFocusedTicketIdx(-1);
    void loadMCPSettings();
  }, [loadMCPSettings]);

  const closeMCPModal = useCallback(() => {
    setShowMCPModal(false);
    setMCPSettingsFeedback("");
  }, []);

  const openHelpModal = useCallback(() => {
    setShowHelp(true);
    setFocusedTicketIdx(-1);
  }, []);

  const closeHelpModal = useCallback(() => {
    setShowHelp(false);
  }, []);

  const openAboutModal = useCallback(() => {
    setShowAboutModal(true);
    setFocusedTicketIdx(-1);
  }, []);

  const closeAboutModal = useCallback(() => {
    setShowAboutModal(false);
  }, []);

  const handleSaveMCPSettings = useCallback(async () => {
    setIsSavingMCPSettings(true);

    try {
      const updatedSettings = (await UpdateMCPSettings(
        mcpSettingsForm.enabled,
        effectiveMCPPort,
      )) as Record<string, any>;
      setMCPSettingsForm(normalizeMCPSettingsForm(updatedSettings));
      setMCPSettingsFeedback("MCP settings saved.");
    } catch (error) {
      console.error("Failed to save MCP settings:", error);
      setMCPSettingsFeedback("Failed to save MCP settings.");
    } finally {
      setIsSavingMCPSettings(false);
    }
  }, [effectiveMCPPort, mcpSettingsForm.enabled]);

  const handleCopyMCPSnippet = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(mcpSnippet);
      setMCPSettingsFeedback("MCP snippet copied.");
    } catch (error) {
      console.error("Failed to copy MCP snippet:", error);
      setMCPSettingsFeedback("Failed to copy MCP snippet.");
    }
  }, [mcpSnippet]);

  const openEditTicketModal = useCallback((ticket: Ticket) => {
    setEditingTicketId(ticket.id);
    setForm({
      name: ticket.name,
      description: ticket.description,
      project: ticket.project,
      link: ticket.link ?? "",
      deadline: ticket.deadline,
      status: ticket.status,
    });
    setShowDetailsModal(false);
    setShowModal(true);
    setFocusedTicketIdx(-1);
  }, []);

  // Handle form input changes
  const handleFormChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
  ) => {
    const { id, value } = e.target;
    setForm((prev) => ({
      ...prev,
      [id.replace("ticket", "").toLowerCase()]: value,
    }));
  };

  // Handle ticket creation
  const handleCreateTicket = (e: React.FormEvent) => {
    e.preventDefault();

    if (editingTicketId !== null) {
      setTickets((prev) =>
        prev.map((t) =>
          t.id === editingTicketId
            ? {
                ...t,
                name: form.name,
                description: form.description,
                project: form.project,
                link: form.link,
                deadline: form.deadline,
                status: form.status as Ticket["status"],
              }
            : t,
        ),
      );

      setSelectedTicket((prev) =>
        prev && prev.id === editingTicketId
          ? {
              ...prev,
              name: form.name,
              description: form.description,
              project: form.project,
              link: form.link,
              deadline: form.deadline,
              status: form.status as Ticket["status"],
            }
          : prev,
      );

      closeModal();
      return;
    }

    const newTicket: Ticket = {
      id: Date.now(),
      name: form.name,
      description: form.description,
      project: form.project,
      link: form.link,
      deadline: form.deadline,
      status: form.status as Ticket["status"],
      comments: [],
    };
    setTickets([...tickets, newTicket]);
    closeModal();
  };

  // Helper: get tickets for a given column index
  const getColumnTickets = useCallback(
    (colIdx: number) =>
      filteredTickets.filter((ticket) => ticket.status === STATUSES[colIdx]),
    [filteredTickets],
  );

  // Delete a ticket by id — opens custom confirm dialog
  const deleteTicket = useCallback(
    (ticketId: number): boolean => {
      const ticketToDelete = tickets.find((t) => t.id === ticketId);
      if (!ticketToDelete) return false;
      setConfirmDeleteTicket(ticketToDelete);
      return true;
    },
    [tickets],
  );

  const performDelete = useCallback(
    (ticketId: number) => {
      const ticketToDelete = tickets.find((t) => t.id === ticketId);
      if (!ticketToDelete) return;
      capturePositions();
      setTickets((prev) => prev.filter((t) => t.id !== ticketId));
      setDeletedTickets((prev) => [
        { ...ticketToDelete, deletedAt: new Date().toISOString() },
        ...prev,
      ]);
      if (selectedTicket?.id === ticketId) {
        setShowDetailsModal(false);
        setSelectedTicket(null);
      }
      setConfirmDeleteTicket(null);
    },
    [capturePositions, selectedTicket, tickets],
  );

  const restoreDeletedTicket = useCallback(
    (ticketId: number) => {
      const ticketToRestore = deletedTickets.find((t) => t.id === ticketId);
      if (!ticketToRestore) return;

      const { deletedAt, ...restoredTicket } = ticketToRestore;
      void deletedAt;

      setTickets((prev) => {
        if (prev.some((t) => t.id === restoredTicket.id)) {
          return prev;
        }
        return [...prev, restoredTicket];
      });
      setDeletedTickets((prev) => prev.filter((t) => t.id !== ticketId));
    },
    [deletedTickets],
  );

  const handleDeleteFromDetails = useCallback(
    (ticket: Ticket) => {
      deleteTicket(ticket.id);
    },
    [deleteTicket],
  );

  // Move a ticket to a new status (for keyboard shortcut 1/2/3)
  const moveTicketToStatus = useCallback(
    (ticketId: number, newStatus: Ticket["status"]) => {
      const ticket = tickets.find((t) => t.id === ticketId);
      if (!ticket || ticket.status === newStatus) return;

      capturePositions();

      setTickets((prev) =>
        prev.map((t) => (t.id === ticketId ? { ...t, status: newStatus } : t)),
      );

      setSelectedTicket((prev) =>
        prev && prev.id === ticketId ? { ...prev, status: newStatus } : prev,
      );

      setEnteringTicketId(ticketId);
      setTimeout(() => setEnteringTicketId(null), 400);
    },
    [tickets, capturePositions],
  );

  // Add comment handler
  const handleAddComment = useCallback(() => {
    if (!comment.trim() || !selectedTicket) return;
    const updatedTickets = tickets.map((t) => {
      if (t.id === selectedTicket.id) {
        const newComments = t.comments
          ? [
              ...t.comments,
              { text: comment, timestamp: new Date().toLocaleString() },
            ]
          : [{ text: comment, timestamp: new Date().toLocaleString() }];
        return { ...t, comments: newComments };
      }
      return t;
    });
    setTickets(updatedTickets);
    setSelectedTicket({
      ...selectedTicket,
      comments: selectedTicket.comments
        ? [
            ...selectedTicket.comments,
            { text: comment, timestamp: new Date().toLocaleString() },
          ]
        : [{ text: comment, timestamp: new Date().toLocaleString() }],
    });
    setComment("");
  }, [comment, selectedTicket, tickets]);

  // ====== Global keyboard shortcuts ======
  useEffect(() => {
    if (!isSearchOpen || !searchInputRef.current) {
      return;
    }

    searchInputRef.current.focus();
  }, [isSearchOpen]);

  useEffect(() => {
    const colTickets = getColumnTickets(focusedColumnIdx);
    if (colTickets.length === 0) {
      if (focusedTicketIdx !== -1) {
        setFocusedTicketIdx(-1);
      }
      return;
    }

    if (focusedTicketIdx >= colTickets.length) {
      setFocusedTicketIdx(colTickets.length - 1);
    }
  }, [focusedColumnIdx, focusedTicketIdx, getColumnTickets]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tagName = target.tagName.toLowerCase();
      const isInInput =
        tagName === "input" || tagName === "textarea" || tagName === "select";

      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
        return;
      }

      // --- Ctrl+N: New ticket ---
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openModal();
        return;
      }

      // --- Ctrl+Shift+N: Start recording ---
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (!isRecording) {
          startRecording();
        }
        return;
      }

      // --- Spacebar: Stop recording if active ---
      if (isRecording && e.code === "Space") {
        e.preventDefault();
        stopRecording();
        return;
      }

      // --- Ctrl+D: Toggle dark mode ---
      if (e.ctrlKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        handleDarkModeToggle();
        return;
      }

      // --- Ctrl+/ or ?: Show help ---
      if ((e.ctrlKey && e.key === "/") || (e.key === "?" && !isInInput)) {
        e.preventDefault();
        setShowHelp((prev) => !prev);
        return;
      }

      // --- Esc: Close modals / help / clear focus ---
      if (e.key === "Escape") {
        if (showAboutModal) {
          e.preventDefault();
          closeAboutModal();
          return;
        }
        if (showMCPModal) {
          e.preventDefault();
          closeMCPModal();
          return;
        }
        if (showDeletedTicketsModal) {
          e.preventDefault();
          closeDeletedTicketsModal();
          return;
        }
        if (showHelp) {
          e.preventDefault();
          closeHelpModal();
          return;
        }
        if (showDetailsModal) {
          e.preventDefault();
          closeDetailsModal();
          return;
        }
        if (showModal) {
          e.preventDefault();
          closeModal();
          return;
        }
        if (isSearchOpen) {
          e.preventDefault();
          closeSearch();
          return;
        }
        if (focusedTicketIdx >= 0) {
          setFocusedTicketIdx(-1);
          return;
        }
        return;
      }

      // --- Shortcuts that only work on the board (no modal, not in input) ---
      if (
        !showModal &&
        !showDetailsModal &&
        !showHelp &&
        !showAboutModal &&
        !showMCPModal &&
        !showDeletedTicketsModal &&
        !isInInput
      ) {
        // --- Ctrl+Arrow Right/Left: move focused ticket to next/prev column ---
        if (e.ctrlKey && e.key === "ArrowRight" && focusedTicketIdx >= 0) {
          e.preventDefault();
          const colTickets = getColumnTickets(focusedColumnIdx);
          if (
            focusedTicketIdx < colTickets.length &&
            focusedColumnIdx < STATUSES.length - 1
          ) {
            const ticket = colTickets[focusedTicketIdx];
            const targetColIdx = focusedColumnIdx + 1;
            const targetStatus = STATUSES[targetColIdx];
            const targetColTickets = tickets.filter(
              (t) => t.status === targetStatus,
            );
            moveTicketToStatus(ticket.id, targetStatus);
            setFocusedColumnIdx(targetColIdx);
            setFocusedTicketIdx(targetColTickets.length); // appended at end
          }
          return;
        }

        if (e.ctrlKey && e.key === "ArrowLeft" && focusedTicketIdx >= 0) {
          e.preventDefault();
          const colTickets = getColumnTickets(focusedColumnIdx);
          if (focusedTicketIdx < colTickets.length && focusedColumnIdx > 0) {
            const ticket = colTickets[focusedTicketIdx];
            const targetColIdx = focusedColumnIdx - 1;
            const targetStatus = STATUSES[targetColIdx];
            const targetColTickets = tickets.filter(
              (t) => t.status === targetStatus,
            );
            moveTicketToStatus(ticket.id, targetStatus);
            setFocusedColumnIdx(targetColIdx);
            setFocusedTicketIdx(targetColTickets.length); // appended at end
          }
          return;
        }

        // --- Arrow Up / Arrow Down: navigate tickets in current column ---
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const colTickets = getColumnTickets(focusedColumnIdx);
          if (colTickets.length === 0) return;
          setFocusedTicketIdx((prev) =>
            prev < colTickets.length - 1 ? prev + 1 : 0,
          );
          return;
        }

        if (e.key === "ArrowUp") {
          e.preventDefault();
          const colTickets = getColumnTickets(focusedColumnIdx);
          if (colTickets.length === 0) return;
          setFocusedTicketIdx((prev) =>
            prev > 0 ? prev - 1 : colTickets.length - 1,
          );
          return;
        }

        // --- Arrow Left / Arrow Right: jump between columns (without Ctrl) ---
        if (e.key === "ArrowLeft" && !e.ctrlKey) {
          e.preventDefault();
          setFocusedColumnIdx((prev) => {
            const next = prev > 0 ? prev - 1 : STATUSES.length - 1;
            const colTickets = tickets.filter(
              (t) => t.status === STATUSES[next],
            );
            setFocusedTicketIdx(colTickets.length > 0 ? 0 : -1);
            return next;
          });
          return;
        }

        if (e.key === "ArrowRight" && !e.ctrlKey) {
          e.preventDefault();
          setFocusedColumnIdx((prev) => {
            const next = prev < STATUSES.length - 1 ? prev + 1 : 0;
            const colTickets = tickets.filter(
              (t) => t.status === STATUSES[next],
            );
            setFocusedTicketIdx(colTickets.length > 0 ? 0 : -1);
            return next;
          });
          return;
        }

        // --- Tab / Shift+Tab / double-Tab ---
        if (e.key === "Tab") {
          e.preventDefault();

          const now = Date.now();
          const timeSinceLastTab = now - lastTabTime.current;
          lastTabTime.current = now;

          if (timeSinceLastTab < DOUBLE_TAB_THRESHOLD) {
            // Double-tab: move to next/prev column
            const direction = e.shiftKey ? -1 : 1;
            setFocusedColumnIdx((prev) => {
              const next =
                (prev + direction + STATUSES.length) % STATUSES.length;
              const colTickets = tickets.filter(
                (t) => t.status === STATUSES[next],
              );
              setFocusedTicketIdx(colTickets.length > 0 ? 0 : -1);
              return next;
            });
          } else if (e.shiftKey) {
            // Shift+Tab: move to previous ticket
            setFocusedColumnIdx((prevCol) => {
              const colTickets = tickets.filter(
                (t) => t.status === STATUSES[prevCol],
              );
              if (colTickets.length === 0) return prevCol;
              setFocusedTicketIdx((prevIdx) =>
                prevIdx > 0 ? prevIdx - 1 : colTickets.length - 1,
              );
              return prevCol;
            });
          } else {
            // Tab: move to next ticket
            setFocusedColumnIdx((prevCol) => {
              const colTickets = tickets.filter(
                (t) => t.status === STATUSES[prevCol],
              );
              if (colTickets.length === 0) return prevCol;
              setFocusedTicketIdx((prevIdx) => {
                const nextIdx = prevIdx + 1;
                return nextIdx >= colTickets.length ? 0 : nextIdx;
              });
              return prevCol;
            });
          }
          return;
        }

        // --- Enter on focused ticket: open details ---
        if (e.key === "Enter" && focusedTicketIdx >= 0) {
          e.preventDefault();
          const colTickets = getColumnTickets(focusedColumnIdx);
          if (focusedTicketIdx < colTickets.length) {
            openDetailsModal(colTickets[focusedTicketIdx]);
          }
          return;
        }

        // --- Delete / Backspace on focused ticket: delete it ---
        if (
          (e.key === "Delete" || e.key === "Backspace") &&
          focusedTicketIdx >= 0
        ) {
          e.preventDefault();
          const colTickets = getColumnTickets(focusedColumnIdx);
          if (focusedTicketIdx < colTickets.length) {
            const ticket = colTickets[focusedTicketIdx];
            const wasDeleted = deleteTicket(ticket.id);
            if (!wasDeleted) return;
            // Adjust focus index
            const remaining = colTickets.length - 1;
            if (remaining <= 0) {
              setFocusedTicketIdx(-1);
            } else if (focusedTicketIdx >= remaining) {
              setFocusedTicketIdx(remaining - 1);
            }
          }
          return;
        }

        // --- 1 / 2 / 3 on focused ticket: quick-move to column ---
        if (
          (e.key === "1" || e.key === "2" || e.key === "3") &&
          focusedTicketIdx >= 0
        ) {
          e.preventDefault();
          const colTickets = getColumnTickets(focusedColumnIdx);
          if (focusedTicketIdx < colTickets.length) {
            const ticket = colTickets[focusedTicketIdx];
            const targetStatus = STATUSES[parseInt(e.key) - 1];
            if (ticket.status !== targetStatus) {
              moveTicketToStatus(ticket.id, targetStatus);
              // Move focus to the new column
              const targetColIdx = parseInt(e.key) - 1;
              setFocusedColumnIdx(targetColIdx);
              // Focus the ticket in its new position (it'll be last)
              const targetColTickets = tickets.filter(
                (t) => t.status === targetStatus,
              );
              setFocusedTicketIdx(targetColTickets.length); // it'll be appended
            }
          }
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    showModal,
    showDetailsModal,
    showDeletedTicketsModal,
    showMCPModal,
    showHelp,
    showAboutModal,
    isRecording,
    focusedColumnIdx,
    focusedTicketIdx,
    tickets,
    openModal,
    closeModal,
    closeDeletedTicketsModal,
    closeMCPModal,
    closeHelpModal,
    closeAboutModal,
    closeDetailsModal,
    closeSearch,
    handleDarkModeToggle,
    openDetailsModal,
    getColumnTickets,
    deleteTicket,
    moveTicketToStatus,
    openSearch,
    startRecording,
    stopRecording,
    isSearchOpen,
  ]);

  // Load tickets from backend on app startup
  useEffect(() => {
    void syncTicketsFromStorage();
  }, [syncTicketsFromStorage]);

  // Listen to native menu commands from Wails runtime
  useEffect(() => {
    const unsubscribeDeleted = EventsOn("openDeletedTickets", () => {
      openDeletedTicketsModal();
    });
    const unsubscribeMCP = EventsOn("openMCPSettings", () => {
      openMCPModal();
    });
    const unsubscribeNewTicket = EventsOn("openNewTicket", () => {
      openModal();
    });
    const unsubscribeShortcuts = EventsOn("openKeyboardShortcuts", () => {
      openHelpModal();
    });
    const unsubscribeAbout = EventsOn("openAbout", () => {
      openAboutModal();
    });
    const unsubscribeTicketsUpdated = EventsOn("ticketsUpdated", () => {
      void syncTicketsFromStorage();
    });
    const unsubscribeMCPSettingsUpdated = EventsOn(
      "mcpSettingsUpdated",
      (settings) => {
        setMCPSettingsForm(normalizeMCPSettingsForm(settings as Record<string, any>));
      },
    );

    return () => {
      unsubscribeDeleted();
      unsubscribeMCP();
      unsubscribeNewTicket();
      unsubscribeShortcuts();
      unsubscribeAbout();
      unsubscribeTicketsUpdated();
      unsubscribeMCPSettingsUpdated();
    };
  }, [
    openDeletedTicketsModal,
    openMCPModal,
    openModal,
    openHelpModal,
    openAboutModal,
    syncTicketsFromStorage,
  ]);

  // Save tickets to backend whenever they change
  useEffect(() => {
    if (!hasLoadedTickets) return;
    if (skipNextStorageSaveRef.current.tickets) {
      skipNextStorageSaveRef.current.tickets = false;
      return;
    }

    const saveTicketsToStorage = async () => {
      try {
        await SaveTickets(tickets);
      } catch (error) {
        console.error("Failed to save tickets:", error);
      }
    };

    saveTicketsToStorage();
  }, [tickets, hasLoadedTickets]);

  // Save deleted tickets to backend whenever they change
  useEffect(() => {
    if (!hasLoadedDeletedTickets) return;
    if (skipNextStorageSaveRef.current.deletedTickets) {
      skipNextStorageSaveRef.current.deletedTickets = false;
      return;
    }

    const saveDeletedTicketsToStorage = async () => {
      try {
        await SaveDeletedTickets(deletedTickets);
      } catch (error) {
        console.error("Failed to save deleted tickets:", error);
      }
    };

    saveDeletedTicketsToStorage();
  }, [deletedTickets, hasLoadedDeletedTickets]);

  // Scroll focused ticket into view
  useEffect(() => {
    if (focusedTicketIdx < 0) return;
    const colTickets = getColumnTickets(focusedColumnIdx);
    if (focusedTicketIdx >= colTickets.length) return;
    const ticket = colTickets[focusedTicketIdx];
    const el = ticketRefs.current.get(ticket.id);
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [focusedColumnIdx, focusedTicketIdx, getColumnTickets]);

  // Render tickets by status
  const renderTickets = (status: Ticket["status"]) => {
    const colIdx = STATUSES.indexOf(status);
    const colTickets = getColumnTickets(colIdx);

    if (colTickets.length === 0 && isSearchActive) {
      return (
        <div className="ticket-search-empty">
          No close matches in this column.
        </div>
      );
    }

    return colTickets.map((ticket, idx) => {
      const isEntering = enteringTicketId === ticket.id;
      const isFocused = colIdx === focusedColumnIdx && idx === focusedTicketIdx;
      const projectStyle = getProjectTicketStyle(ticket.project, darkMode);
      const classes = [
        "ticket",
        isEntering ? "ticket-enter" : "",
        isFocused ? "ticket-focused" : "",
      ]
        .filter(Boolean)
        .join(" ");

      return (
        <div
          key={ticket.id}
          ref={(el) => {
            if (el) ticketRefs.current.set(ticket.id, el);
            else ticketRefs.current.delete(ticket.id);
          }}
          className={classes}
          draggable
          onDragStart={(e) => handleDragStart(e, ticket.id)}
          onDragEnd={handleDragEnd}
          onClick={() => openDetailsModal(ticket)}
          style={{
            cursor: "grab",
            ...projectStyle,
          }}
        >
          <div className="ticket-title">{ticket.name}</div>
          <div className="ticket-desc">{ticket.description}</div>
          <div className="ticket-meta">
            <span>{ticket.project}</span>
            {ticket.link && (
              <a href={ticket.link} target="_blank" rel="noopener noreferrer">
                🔗
              </a>
            )}
            <span>{ticket.deadline}</span>
          </div>
        </div>
      );
    });
  };

  const columnData: { title: string; status: Ticket["status"] }[] = [
    { title: "To Do", status: "todo" },
    { title: "In Progress", status: "inprogress" },
    { title: "Done", status: "done" },
  ];

  return (
    <div id="App">
      <div className="header">
        <h1>Tinier Todo</h1>
        <div className="header-buttons">
          <div className={`search-control${isSearchOpen ? " search-control-open" : ""}`}>
            <button
              type="button"
              className={`search-btn${isSearchActive ? " search-btn-active" : ""}`}
              title={isSearchOpen ? "Close search" : "Search tickets (Ctrl+F)"}
              aria-label={isSearchOpen ? "Close search" : "Search tickets"}
              onClick={handleSearchToggle}
            >
              🔎
            </button>
            {isSearchOpen && (
              <input
                ref={searchInputRef}
                type="text"
                className="search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Fuzzy search tickets"
                aria-label="Search tickets"
              />
            )}
          </div>
          <button
            id="darkModeToggle"
            className="theme-toggle"
            title="Toggle dark mode (Ctrl+D)"
            onClick={handleDarkModeToggle}
          >
            <span className="light-icon">☀️</span>
            <span className="dark-icon">🌙</span>
          </button>
          <button
            className="help-btn"
            title="Keyboard shortcuts (Ctrl+/)"
            onClick={openHelpModal}
          >
            ?
          </button>
          <button
            id="newTicketBtn"
            onClick={openModal}
          >
            New Ticket
          </button>
          <button
            id="micBtn"
            className={`mic-btn ${isRecording ? "recording" : ""}`}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
            title={
              isRecording
                ? "Stop recording (Space)"
                : "Start recording (Ctrl+Shift+N)"
            }
            onClick={isRecording ? stopRecording : startRecording}
          >
            🎤
          </button>
        </div>
      </div>

      <div className="board">
        {columnData.map(({ title, status }, colIdx) => (
          <div
            key={status}
            className={`column${dragOverColumn === status ? " drag-over" : ""}${colIdx === focusedColumnIdx && focusedTicketIdx >= 0 ? " column-active" : ""}`}
            onDragOver={(e) => handleDragOver(e, status)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, status)}
          >
            <h2>
              {title}
              {isSearchActive && (
                <span className="column-match-count">
                  {getColumnTickets(colIdx).length}
                </span>
              )}
            </h2>
            <div className="ticket-list" id={status}>
              {renderTickets(status)}
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <div
          id="ticketModal"
          className="modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div className="modal-content">
            <span
              className="close"
              aria-label="Close modal"
              onClick={closeModal}
            >
              &times;
            </span>
            <div className="modal-title">
              {editingTicketId !== null ? "Edit Ticket" : "New Ticket"}
            </div>
            <form id="ticketForm" onSubmit={handleCreateTicket}>
              <div className="form-group left-label">
                <label htmlFor="ticketName">Name</label>
                <input
                  type="text"
                  id="ticketName"
                  required
                  value={form.name}
                  onChange={handleFormChange}
                  autoFocus
                />
              </div>
              <div className="form-group left-label">
                <label htmlFor="ticketDescription">Description</label>
                <textarea
                  id="ticketDescription"
                  required
                  value={form.description}
                  onChange={handleFormChange}
                />
              </div>
              <div className="form-group left-label">
                <label htmlFor="ticketProject">Project</label>
                <input
                  type="text"
                  id="ticketProject"
                  required
                  value={form.project}
                  onChange={handleFormChange}
                  list="projectSuggestions"
                  placeholder="Select existing or type new"
                />
                <datalist id="projectSuggestions">
                  {projectSuggestions.map((projectName) => (
                    <option
                      key={projectName}
                      value={projectName}
                    />
                  ))}
                </datalist>
              </div>
              <div className="form-group left-label">
                <label htmlFor="ticketStatus">Status</label>
                <select
                  id="ticketStatus"
                  value={form.status}
                  onChange={handleFormChange}
                >
                  <option value="todo">To Do</option>
                  <option value="inprogress">In Progress</option>
                  <option value="done">Done</option>
                </select>
              </div>
              <div className="form-group left-label">
                <label htmlFor="ticketLink">Link (Optional)</label>
                <input
                  type="url"
                  id="ticketLink"
                  value={form.link}
                  onChange={handleFormChange}
                />
              </div>
              <div className="form-group left-label">
                <label htmlFor="ticketDeadline">Deadline</label>
                <input
                  type="date"
                  id="ticketDeadline"
                  value={form.deadline}
                  onChange={handleFormChange}
                />
              </div>
              <button type="submit">
                {editingTicketId !== null ? "Save Changes" : "Create Ticket"}
              </button>
            </form>
          </div>
        </div>
      )}

      <TicketDetails
        ticket={selectedTicket}
        show={showDetailsModal}
        onClose={closeDetailsModal}
        comment={comment}
        setComment={setComment}
        onAddComment={handleAddComment}
        onEdit={openEditTicketModal}
        onDelete={handleDeleteFromDetails}
      />

      {showDeletedTicketsModal && (
        <div
          className="modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDeletedTicketsModal();
          }}
        >
          <div className="modal-content deleted-tickets-modal">
            <span
              className="close"
              aria-label="Close deleted tickets"
              onClick={closeDeletedTicketsModal}
            >
              &times;
            </span>
            <div className="modal-title">Deleted Tickets</div>
            {deletedTickets.length === 0 ? (
              <div className="deleted-empty">No deleted tickets yet.</div>
            ) : (
              <div className="deleted-ticket-list">
                {deletedTickets.map((ticket) => (
                  <div key={ticket.id} className="deleted-ticket-item">
                    <div className="deleted-ticket-info">
                      <div className="deleted-ticket-name">{ticket.name}</div>
                      <div className="deleted-ticket-meta">
                        {ticket.project} • {ticket.status} • Deleted {" "}
                        {new Date(ticket.deletedAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      className="restore-ticket-btn"
                      onClick={() => restoreDeletedTicket(ticket.id)}
                    >
                      Retrieve
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {showMCPModal && (
        <div
          className="modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeMCPModal();
          }}
        >
          <div className="modal-content mcp-modal">
            <span
              className="close"
              aria-label="Close MCP settings"
              onClick={closeMCPModal}
            >
              &times;
            </span>
            <div className="modal-title">MCP</div>
            <div className="mcp-settings-grid">
              <div className="mcp-toggle-row">
                <div className="mcp-setting-copy-block">
                  <div className="mcp-setting-label">MCP Server</div>
                  <div className="mcp-setting-hint">
                    Enable or disable the built-in SSE endpoint for external LLM clients.
                  </div>
                </div>
                <label className="mcp-toggle">
                  <input
                    type="checkbox"
                    checked={mcpSettingsForm.enabled}
                    onChange={(e) => {
                      setMCPSettingsForm((prev) => ({
                        ...prev,
                        enabled: e.target.checked,
                      }));
                      setMCPSettingsFeedback("");
                    }}
                  />
                  <span>{mcpSettingsForm.enabled ? "Enabled" : "Disabled"}</span>
                </label>
              </div>

              <div className="form-group left-label">
                <label htmlFor="mcpPort">Port</label>
                <input
                  id="mcpPort"
                  type="number"
                  min="1"
                  max="65535"
                  value={mcpSettingsForm.port}
                  onChange={(e) => {
                    setMCPSettingsForm((prev) => ({
                      ...prev,
                      port: e.target.value,
                    }));
                    setMCPSettingsFeedback("");
                  }}
                />
              </div>

              <div className="mcp-readonly-block">
                <div className="mcp-setting-label">SSE Endpoint</div>
                <div className="mcp-endpoint">{mcpURL}</div>
              </div>

              <div className="mcp-readonly-block">
                <div className="mcp-setting-label">Config Snippet</div>
                <div className="mcp-setting-hint">
                  Copy and paste this snippet into your MCP-capable client config.
                </div>
                <pre className="mcp-snippet">{mcpSnippet}</pre>
              </div>

              {mcpSettingsFeedback && (
                <div className="mcp-feedback">{mcpSettingsFeedback}</div>
              )}

              <div className="mcp-actions">
                <button
                  type="button"
                  className="mcp-copy-btn"
                  onClick={() => {
                    void handleCopyMCPSnippet();
                  }}
                >
                  Copy Snippet
                </button>
                <button
                  type="button"
                  className="mcp-save-btn"
                  onClick={() => {
                    void handleSaveMCPSettings();
                  }}
                  disabled={isSavingMCPSettings}
                >
                  {isSavingMCPSettings ? "Saving..." : "Save MCP Settings"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showAboutModal && (
        <div
          className="modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAboutModal();
          }}
        >
          <div className="modal-content help-modal">
            <span
              className="close"
              aria-label="Close about"
              onClick={closeAboutModal}
            >
              &times;
            </span>
            <div className="modal-title">About Tinier Todo</div>
            <div className="about-content">
              <p><strong>Made by:</strong> Ritvik Joshi</p>
              <p><strong>Version:</strong> {appVersion || "dev"}</p>
              <p><strong>Licence:</strong> MIT</p>
              <p><strong>Platform:</strong> Wails (Go + React)</p>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {confirmDeleteTicket && (
        <div
          className="modal confirm-delete-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmDeleteTicket(null);
          }}
        >
          <div className="confirm-delete-dialog">
            <div className="confirm-delete-icon">🗑</div>
            <div className="confirm-delete-title">Delete Ticket?</div>
            <div className="confirm-delete-name">"{confirmDeleteTicket.name}"</div>
            <div className="confirm-delete-subtitle">This action cannot be undone (but can be restored from the deleted tickets list).</div>
            <div className="confirm-delete-actions">
              <button
                className="confirm-delete-cancel"
                onClick={() => setConfirmDeleteTicket(null)}
              >
                Cancel
              </button>
              <button
                className="confirm-delete-confirm"
                onClick={() => performDelete(confirmDeleteTicket.id)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyboard shortcuts help overlay */}
      {showHelp && (
        <div
          className="modal"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeHelpModal();
          }}
        >
          <div className="modal-content help-modal">
            <span
              className="close"
              aria-label="Close help"
              onClick={closeHelpModal}
            >
              &times;
            </span>
            <div className="modal-title">⌨️ Keyboard Shortcuts</div>
            <div className="help-grid">
              <div className="help-section">
                <h3>General</h3>
                <div className="help-row">
                  <kbd>Ctrl</kbd>+<kbd>N</kbd>
                  <span>New ticket</span>
                </div>
                <div className="help-row">
                  <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>
                  <span>Start voice recording</span>
                </div>
                <div className="help-row">
                  <kbd>Space</kbd>
                  <span>Stop voice recording</span>
                </div>
                <div className="help-row">
                  <kbd>Ctrl</kbd>+<kbd>D</kbd>
                  <span>Toggle dark mode</span>
                </div>
                <div className="help-row">
                  <kbd>Ctrl</kbd>+<kbd>F</kbd>
                  <span>Search tickets</span>
                </div>
                <div className="help-row">
                  <kbd>Ctrl</kbd>+<kbd>/</kbd>
                  <span>Show this help</span>
                </div>
                <div className="help-row">
                  <kbd>Esc</kbd>
                  <span>Close modal / clear focus</span>
                </div>
              </div>
              <div className="help-section">
                <h3>Navigation</h3>
                <div className="help-row">
                  <kbd>↑</kbd> <kbd>↓</kbd>
                  <span>Navigate tickets</span>
                </div>
                <div className="help-row">
                  <kbd>←</kbd> <kbd>→</kbd>
                  <span>Switch columns</span>
                </div>
                <div className="help-row">
                  <kbd>Tab</kbd>
                  <span>Next ticket</span>
                </div>
                <div className="help-row">
                  <kbd>Shift</kbd>+<kbd>Tab</kbd>
                  <span>Previous ticket</span>
                </div>
                <div className="help-row">
                  <kbd>Tab</kbd>
                  <kbd>Tab</kbd>
                  <span>Next column</span>
                </div>
                <div className="help-row">
                  <kbd>Enter</kbd>
                  <span>Open ticket details</span>
                </div>
              </div>
              <div className="help-section">
                <h3>Ticket Actions</h3>
                <div className="help-row">
                  <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd>
                  <span>Move to To Do / In Progress / Done</span>
                </div>
                <div className="help-row">
                  <kbd>Ctrl</kbd>+<kbd>→</kbd>
                  <span>Move ticket to next column</span>
                </div>
                <div className="help-row">
                  <kbd>Ctrl</kbd>+<kbd>←</kbd>
                  <span>Move ticket to previous column</span>
                </div>
                <div className="help-row">
                  <kbd>Del</kbd>
                  <span>Delete focused ticket</span>
                </div>
              </div>
              <div className="help-section">
                <h3>In Ticket Details</h3>
                <div className="help-row">
                  <kbd>Enter</kbd>
                  <span>Submit comment</span>
                </div>
                <div className="help-row">
                  <kbd>Shift</kbd>+<kbd>Enter</kbd>
                  <span>New line in comment</span>
                </div>
                <div className="help-row">
                  <kbd>Esc</kbd>
                  <span>Close ticket</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
