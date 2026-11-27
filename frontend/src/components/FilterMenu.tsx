import React, { useEffect, useRef, useState } from "react";
import { CheckIcon, CloseIcon, FilterIcon } from "../icons";
import { DUE_FILTER_LABELS, DueFilter, Filters, hasFilters } from "../lib/search";
import { projectHueStyle } from "../projectColor";

export type ProjectOption = { key: string; name: string; count: number };

const DUE_OPTIONS = Object.entries(DUE_FILTER_LABELS) as [Exclude<DueFilter, "">, string][];

/** The filter button in the header and its dropdown. */
export function FilterMenu({
  filters,
  projects,
  onChange,
}: {
  filters: Filters;
  projects: ProjectOption[];
  onChange: (filters: Filters) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const active = hasFilters(filters);
  const count = filters.projects.length + (filters.due ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const toggleProject = (key: string) => {
    const projectsNext = filters.projects.includes(key)
      ? filters.projects.filter((p) => p !== key)
      : [...filters.projects, key];
    onChange({ ...filters, projects: projectsNext });
  };

  return (
    <div className="tools-menu-container filter-menu" ref={ref}>
      <button
        type="button"
        className={`icon-button filter-button${active ? " filter-button-active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={active ? `Filters (${count} active)` : "Filter tickets"}
        title="Filter tickets"
        onClick={() => setOpen((prev) => !prev)}
      >
        <FilterIcon />
        {active && <span className="filter-count">{count}</span>}
      </button>
      {open && (
        <div className="tools-menu-dropdown filter-dropdown" role="menu">
          <div className="menu-section-title">Due</div>
          {DUE_OPTIONS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={filters.due === value}
              className="tools-menu-item board-menu-item"
              onClick={() => onChange({ ...filters, due: filters.due === value ? "" : value })}
            >
              <span className="board-menu-check">
                {filters.due === value && <CheckIcon size={14} />}
              </span>
              <span className="board-menu-name">{label}</span>
            </button>
          ))}

          <div className="board-menu-separator" />
          <div className="menu-section-title">Project</div>
          {projects.length === 0 ? (
            <div className="menu-empty">No projects on this board yet.</div>
          ) : (
            projects.map((project) => (
              <button
                key={project.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={filters.projects.includes(project.key)}
                className="tools-menu-item board-menu-item"
                style={projectHueStyle(project.name)}
                onClick={() => toggleProject(project.key)}
              >
                <span className="board-menu-check">
                  {filters.projects.includes(project.key) && <CheckIcon size={14} />}
                </span>
                <span className="project-dot" />
                <span className="board-menu-name">{project.name || "No project"}</span>
                <span className="menu-count">{project.count}</span>
              </button>
            ))
          )}

          {active && (
            <>
              <div className="board-menu-separator" />
              <button
                type="button"
                className="tools-menu-item board-menu-item"
                onClick={() => {
                  onChange({ projects: [], due: "" });
                  setOpen(false);
                }}
              >
                <span className="board-menu-check" />
                <span className="board-menu-name">Clear filters</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Chips under the header showing the active filters. */
export function FilterBar({
  filters,
  projects,
  shown,
  total,
  onChange,
}: {
  filters: Filters;
  projects: ProjectOption[];
  shown: number;
  total: number;
  onChange: (filters: Filters) => void;
}) {
  if (!hasFilters(filters)) return null;
  const nameOf = (key: string) => projects.find((p) => p.key === key)?.name || "No project";

  return (
    <div className="filter-bar" aria-label="Active filters">
      <span className="filter-bar-label">
        Showing {shown} of {total}
      </span>
      {filters.due && (
        <span className="filter-chip">
          {DUE_FILTER_LABELS[filters.due]}
          <button
            type="button"
            aria-label={`Remove filter ${DUE_FILTER_LABELS[filters.due]}`}
            onClick={() => onChange({ ...filters, due: "" })}
          >
            <CloseIcon size={12} />
          </button>
        </span>
      )}
      {filters.projects.map((key) => (
        <span key={key} className="filter-chip" style={projectHueStyle(nameOf(key))}>
          <span className="project-dot" />
          {nameOf(key)}
          <button
            type="button"
            aria-label={`Remove filter ${nameOf(key)}`}
            onClick={() => onChange({ ...filters, projects: filters.projects.filter((p) => p !== key) })}
          >
            <CloseIcon size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="filter-clear" onClick={() => onChange({ projects: [], due: "" })}>
        Clear
      </button>
    </div>
  );
}
