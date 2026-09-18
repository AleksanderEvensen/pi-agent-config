import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const identity = (text: string): string => text;

export type FrameContent = {
  readonly title: string;
  readonly rightTitle?: string;
  readonly lines: readonly string[];
};

export type FrameStyles = {
  readonly border?: (text: string) => string;
  readonly title?: (text: string) => string;
  readonly rightTitle?: (text: string) => string;
};

/** A width-safe, titled frame for persistent widgets and custom extension UI. */
export class FramedWidget implements Component {
  readonly #content: (innerWidth: number) => FrameContent;
  readonly #border: (text: string) => string;
  readonly #title: (text: string) => string;
  readonly #rightTitle: (text: string) => string;

  constructor(content: (innerWidth: number) => FrameContent, styles: FrameStyles = {}) {
    this.#content = content;
    this.#border = styles.border ?? identity;
    this.#title = styles.title ?? identity;
    this.#rightTitle = styles.rightTitle ?? this.#title;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);

    if (safeWidth < 4) return [this.#border("─".repeat(safeWidth))];

    const innerWidth = safeWidth - 4;
    const { title, rightTitle, lines } = this.#content(innerWidth);

    const top =
      safeWidth < 8
        ? this.#border(`╭${"─".repeat(safeWidth - 2)}╮`)
        : this.#renderTop(safeWidth, title, rightTitle);

    const body = lines.map((line) => {
      const content = truncateToWidth(line, innerWidth, "…", true);

      return `${this.#border("│ ")}${content}${this.#border(" │")}`;
    });

    const bottom = this.#border(`╰${"─".repeat(safeWidth - 2)}╯`);

    return [top, ...body, bottom];
  }

  #renderTop(width: number, title: string, rightTitle?: string): string {
    const fixedWidth = 8;

    const right = rightTitle
      ? truncateToWidth(rightTitle, Math.max(0, Math.floor((width - fixedWidth) / 2)), "…")
      : "";

    const titleWidth = Math.max(0, width - fixedWidth - visibleWidth(right) - 1);
    const left = truncateToWidth(title, titleWidth, "…");
    const labelsWidth = visibleWidth(left) + visibleWidth(right);
    const fill = "─".repeat(Math.max(1, width - fixedWidth - labelsWidth));

    if (right) {
      return [
        this.#border("╭─ "),
        this.#title(left),
        this.#border(` ${fill} `),
        this.#rightTitle(right),
        this.#border(" ─╮"),
      ].join("");
    }

    const singleFill = "─".repeat(Math.max(1, width - 5 - visibleWidth(left)));

    return `${this.#border("╭─ ")}${this.#title(left)}${this.#border(` ${singleFill}╮`)}`;
  }
}
