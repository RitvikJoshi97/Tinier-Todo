import React from "react";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime";

/*
 * A small Markdown renderer for ticket descriptions and comments.
 *
 * Supported: paragraphs and line breaks, # headings, - / * / 1. lists,
 * - [ ] task items, > quotes, ``` code blocks, **bold**, *italic*, ~~strike~~,
 * `code`, [links](https://…) and bare https:// links.
 *
 * It builds React elements and never injects HTML, so ticket text can't run
 * scripts. Links only open for http(s) and mailto, in the system browser.
 */

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/**
 * The address a ticket's link opens, or null when it isn't safe to open: only
 * web and email links are, since links open in the system's default handler
 * (a file:// path or another app's URL scheme could run something). A link
 * without a scheme gets https:// in front. Mirrors cleanLink in security.go.
 */
export function safeLinkHref(link: string | undefined): string | null {
  const trimmed = (link ?? "").trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const href = lower.includes("://") || lower.startsWith("mailto:") ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(href);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) return href;
    if (url.protocol === "mailto:" && url.pathname) return href;
  } catch {
    // not a valid address
  }
  return null;
}

export function openExternal(url: string) {
  try {
    BrowserOpenURL(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  if (!SAFE_URL.test(href)) return <>{children}</>;
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

// Inline patterns, tried in this order at each position.
const INLINE = [
  { type: "code", re: /^`([^`]+)`/ },
  { type: "link", re: /^\[([^\]]+)\]\(([^)\s]+)\)/ },
  { type: "url", re: /^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/ },
  { type: "bold", re: /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/ },
  { type: "strike", re: /^~~(?=\S)([\s\S]*?\S)~~/ },
  { type: "italic", re: /^(\*|_)(?=\S)([\s\S]*?\S)\1(?![\w*])/ },
] as const;

export function renderInline(text: string, keyPrefix = "i"): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let plain = "";
  let i = 0;
  let key = 0;
  const flush = () => {
    if (plain) {
      out.push(plain);
      plain = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);
    // Italic with _ only at a word boundary, so snake_case stays as it is.
    const prev = i > 0 ? text[i - 1] : " ";
    let matched = false;
    for (const { type, re } of INLINE) {
      if (type === "italic" && rest[0] === "_" && /\w/.test(prev)) continue;
      if ((type === "bold" || type === "italic") && rest[0] === "_" && /\w/.test(prev)) continue;
      const m = re.exec(rest);
      if (!m) continue;
      flush();
      const k = `${keyPrefix}-${key++}`;
      switch (type) {
        case "code":
          out.push(<code key={k}>{m[1]}</code>);
          break;
        case "link":
          out.push(
            <Link key={k} href={m[2]}>
              {renderInline(m[1], k)}
            </Link>,
          );
          break;
        case "url":
          out.push(
            <Link key={k} href={m[1]}>
              {m[1]}
            </Link>,
          );
          break;
        case "bold":
          out.push(<strong key={k}>{renderInline(m[2], k)}</strong>);
          break;
        case "strike":
          out.push(<del key={k}>{renderInline(m[1], k)}</del>);
          break;
        case "italic":
          out.push(<em key={k}>{renderInline(m[2], k)}</em>);
          break;
      }
      i += m[0].length;
      matched = true;
      break;
    }
    if (!matched) {
      plain += text[i];
      i++;
    }
  }
  flush();
  return out;
}

function withBreaks(lines: string[], keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(<br key={`${keyPrefix}-br${idx}`} />);
    out.push(...renderInline(line, `${keyPrefix}-${idx}`));
  });
  return out;
}

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

export function renderMarkdown(source: string): React.ReactNode {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    const k = `b${key++}`;

    if (!line.trim()) {
      i++;
      continue;
    }

    // ``` code block
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence (or end of text)
      blocks.push(
        <pre key={k} className="md-code">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // # heading
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={k} className="md-heading">
          {renderInline(heading[1], k)}
        </p>,
      );
      i++;
      continue;
    }

    // > quote
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(<blockquote key={k}>{withBreaks(quote, k)}</blockquote>);
      continue;
    }

    // lists
    const first = LIST_ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i]);
        if (item && /\d/.test(item[1]) === ordered) {
          items.push(item[2]);
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += "\n" + lines[i].trim(); // continuation
        } else {
          break;
        }
        i++;
      }
      const children = items.map((item, idx) => {
        const task = TASK.exec(item);
        const ik = `${k}-${idx}`;
        if (task) {
          const done = task[1] !== " ";
          return (
            <li key={ik} className={`md-task${done ? " md-task-done" : ""}`}>
              <span className="md-checkbox" aria-hidden="true" />
              <span>{withBreaks(task[2].split("\n"), ik)}</span>
            </li>
          );
        }
        return <li key={ik}>{withBreaks(item.split("\n"), ik)}</li>;
      });
      blocks.push(ordered ? <ol key={k}>{children}</ol> : <ul key={k}>{children}</ul>);
      continue;
    }

    // paragraph: consecutive plain lines
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !LIST_ITEM.test(lines[i]) &&
      !/^\s*(```|>|#{1,6}\s)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={k}>{withBreaks(para, k)}</p>);
  }

  return <>{blocks}</>;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`markdown${className ? ` ${className}` : ""}`}>{renderMarkdown(text)}</div>;
}

/** Plain text for previews (ticket cards): Markdown syntax removed. */
export function stripMarkdown(source: string): string {
  const lines = source
    .replace(/```[\s\S]*?(```|$)/g, (block) => block.replace(/```/g, ""))
    .split("\n")
    .map((line) => {
      // Headings and list items become separate parts of the preview.
      const item = /^\s{0,3}#{1,6}\s+/.test(line) || /^\s*([-*+]|\d+[.)])\s+/.test(line);
      const text = line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
        .trim();
      return { item, text };
    })
    .filter((line) => line.text);

  // "Title", "- one", "- two" reads "Title · one · two"; ordinary lines and
  // text ending in punctuation ("Steps:") are joined with a space.
  let joined = "";
  lines.forEach((line, i) => {
    if (i > 0) {
      const previous = lines[i - 1];
      const separate = (line.item || previous.item) && !/[.:;!?,]$/.test(previous.text);
      joined += separate ? " · " : " ";
    }
    joined += line.text;
  });

  return joined
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(^|[^\w*])(\*|_)(?=\S)([^*_\n]*?\S)\2(?![\w*])/g, "$1$3")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
