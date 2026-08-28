/** Play a small terminal Pong game with /pong. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BOARD_WIDTH = 40;
const BOARD_HEIGHT = 16;
const PADDLE_HEIGHT = 4;
const TICK_MS = 100;

type Styles = {
  accent: (text: string) => string;
  ball: (text: string) => string;
  paddle: (text: string) => string;
  muted: (text: string) => string;
  score: (text: string) => string;
};

type GameState = {
  playerY: number;
  opponentY: number;
  ballX: number;
  ballY: number;
  velocityX: number;
  velocityY: number;
  playerScore: number;
  opponentScore: number;
};

function newGame(): GameState {
  return {
    playerY: Math.floor((BOARD_HEIGHT - PADDLE_HEIGHT) / 2),
    opponentY: Math.floor((BOARD_HEIGHT - PADDLE_HEIGHT) / 2),
    ballX: Math.floor(BOARD_WIDTH / 2),
    ballY: Math.floor(BOARD_HEIGHT / 2),
    velocityX: 1,
    velocityY: 1,
    playerScore: 0,
    opponentScore: 0,
  };
}

class PongComponent {
  private readonly state = newGame();
  private readonly interval: ReturnType<typeof setInterval>;
  private readonly styles: Styles;
  private readonly tui: { requestRender: () => void };
  private readonly onClose: () => void;
  private cachedLines: string[] | undefined;
  private version = 0;
  private cachedVersion = -1;
  private closed = false;

  constructor(tui: { requestRender: () => void }, styles: Styles, onClose: () => void) {
    this.tui = tui;
    this.styles = styles;
    this.onClose = onClose;
    this.interval = setInterval(() => {
      this.tick();
      this.version++;
      this.invalidate();
      this.tui.requestRender();
    }, TICK_MS);
  }

  private tick(): void {
    const { state } = this;

    // The opponent is intentionally simple: move one cell toward the ball.
    const opponentCenter = state.opponentY + PADDLE_HEIGHT / 2;
    if (opponentCenter < state.ballY) state.opponentY++;
    if (opponentCenter > state.ballY) state.opponentY--;
    state.opponentY = Math.max(0, Math.min(BOARD_HEIGHT - PADDLE_HEIGHT, state.opponentY));

    const nextX = state.ballX + state.velocityX;
    const nextY = state.ballY + state.velocityY;

    if (nextY < 0 || nextY >= BOARD_HEIGHT) {
      state.velocityY *= -1;
      state.ballY += state.velocityY;
    } else {
      state.ballY = nextY;
    }

    const playerHit =
      nextX === 1 && state.velocityX < 0 && this.paddleContains(state.playerY, state.ballY);
    const opponentHit =
      nextX === BOARD_WIDTH - 2 &&
      state.velocityX > 0 &&
      this.paddleContains(state.opponentY, state.ballY);

    if (playerHit || opponentHit) {
      state.velocityX *= -1;
      state.ballX += state.velocityX;
      return;
    }

    state.ballX = nextX;
    if (state.ballX < 0) {
      state.opponentScore++;
      this.resetBall(1);
    } else if (state.ballX >= BOARD_WIDTH) {
      state.playerScore++;
      this.resetBall(-1);
    }
  }

  private paddleContains(paddleY: number, ballY: number): boolean {
    return ballY >= paddleY && ballY < paddleY + PADDLE_HEIGHT;
  }

  private resetBall(direction: number): void {
    this.state.ballX = Math.floor(BOARD_WIDTH / 2);
    this.state.ballY = Math.floor(BOARD_HEIGHT / 2);
    this.state.velocityX = direction;
    this.state.velocityY = Math.random() < 0.5 ? -1 : 1;
  }

  handleInput(data: string): void {
    if (data === "q" || data === "Q") {
      this.close();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.state.playerY = Math.max(0, this.state.playerY - 1);
    } else if (matchesKey(data, Key.down)) {
      this.state.playerY = Math.min(BOARD_HEIGHT - PADDLE_HEIGHT, this.state.playerY + 1);
    } else {
      return;
    }

    this.version++;
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedVersion === this.version) return this.cachedLines;

    const lines: string[] = [];
    const { state } = this;
    const dim = this.styles.muted;
    const boardLine = (content: string) => this.fit(`│${content}│`, width);

    lines.push(this.fit(dim(`╭${"─".repeat(BOARD_WIDTH)}╮`), width));
    lines.push(
      boardLine(
        ` ${this.styles.accent("PONG")}   ${this.styles.score(`${state.playerScore} : ${state.opponentScore}`)}`,
      ),
    );
    lines.push(this.fit(dim(`├${"─".repeat(BOARD_WIDTH)}┤`), width));

    for (let y = 0; y < BOARD_HEIGHT; y++) {
      const row = Array.from({ length: BOARD_WIDTH }, () => " ");
      if (y % 2 === 0) row[Math.floor(BOARD_WIDTH / 2)] = dim("┊");
      if (this.paddleContains(state.playerY, y)) row[1] = this.styles.paddle("█");
      if (this.paddleContains(state.opponentY, y)) row[BOARD_WIDTH - 2] = this.styles.paddle("█");
      if (state.ballY === y && state.ballX >= 0 && state.ballX < BOARD_WIDTH)
        row[state.ballX] = this.styles.ball("●");
      lines.push(boardLine(row.join("")));
    }

    lines.push(this.fit(dim(`├${"─".repeat(BOARD_WIDTH)}┤`), width));
    lines.push(boardLine(dim("↑ / ↓ move    q quit")));
    lines.push(this.fit(dim(`╰${"─".repeat(BOARD_WIDTH)}╯`), width));

    this.cachedLines = lines;
    this.cachedVersion = this.version;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedVersion = -1;
  }

  private fit(line: string, width: number): string {
    const fitted = truncateToWidth(line, Math.max(0, width), "");
    return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.interval);
    this.onClose();
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pong", {
    description: "Play Pong",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Pong requires interactive mode", "error");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const game = new PongComponent(
          tui,
          {
            accent: (text) => theme.fg("accent", text),
            ball: (text) => theme.fg("warning", text),
            paddle: (text) => theme.fg("success", text),
            muted: (text) => theme.fg("muted", text),
            score: (text) => theme.fg("text", text),
          },
          () => done(undefined),
        );

        return {
          render: (width) => game.render(width),
          handleInput: (data) => game.handleInput(data),
          invalidate: () => game.invalidate(),
        };
      });
    },
  });
}
