import React from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Markdown, stripMarkdown } from "./markdown";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime";

describe("Markdown", () => {
  it("renders inline formatting", () => {
    const { container } = render(<Markdown text={"**bold** and *italic*, `code` and ~~gone~~"} />);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelector("del")?.textContent).toBe("gone");
  });

  it("leaves snake_case and lone asterisks alone", () => {
    const { container } = render(<Markdown text="use some_variable_name and 2 * 3" />);
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("use some_variable_name and 2 * 3");
  });

  it("renders lists, tasks, quotes, headings and code blocks", () => {
    const text = "# Plan\n\n- one\n- [x] two\n- [ ] three\n\n1. first\n2. second\n\n> quoted\n\n```\nconst a = 1;\n```";
    const { container } = render(<Markdown text={text} />);
    expect(container.querySelector(".md-heading")?.textContent).toBe("Plan");
    expect(container.querySelectorAll("ul > li")).toHaveLength(3);
    expect(container.querySelectorAll(".md-task-done")).toHaveLength(1);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(container.querySelector("blockquote")?.textContent).toBe("quoted");
    expect(container.querySelector("pre code")?.textContent).toBe("const a = 1;");
  });

  it("keeps line breaks inside a paragraph", () => {
    const { container } = render(<Markdown text={"line one\nline two\n\nnext paragraph"} />);
    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelectorAll("br")).toHaveLength(1);
  });

  it("opens safe links in the system browser", () => {
    render(<Markdown text="See [the docs](https://example.com/docs) or https://example.org." />);
    fireEvent.click(screen.getByText("the docs"));
    expect(BrowserOpenURL).toHaveBeenCalledWith("https://example.com/docs");
    expect(screen.getByText("https://example.org").tagName).toBe("A"); // trailing "." not included
  });

  it("never renders HTML or unsafe links", () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror="alert(1)"> [click](javascript:alert(1))'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });
});

describe("stripMarkdown", () => {
  it("turns Markdown into a plain one-line preview", () => {
    expect(stripMarkdown("# Title\n- **Bold** item\n- [x] done [link](https://x.y)")).toBe(
      "Title · Bold item · done link",
    );
    expect(stripMarkdown("Outline the bets:\n\n- [x] Boards\n- [ ] Sync\n\nThen ship.")).toBe(
      "Outline the bets: Boards · Sync · Then ship.",
    );
    expect(stripMarkdown("Line one\nline two")).toBe("Line one line two");
    expect(stripMarkdown("keep some_variable and *emphasis*")).toBe("keep some_variable and emphasis");
  });
});
