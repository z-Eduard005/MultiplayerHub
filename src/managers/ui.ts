import { execSync } from "child_process";

type LayoutOptions = {
  title?: string;
  desc?: string;
  backText?: string | null;
  action?: { label: string; run: () => void | Promise<void> };
}

type InputOptions = LayoutOptions & {
  defaultValue?: string;
  maxLen?: number;
  filter?: RegExp;
  validate?: (value: string) => string | null;
  allowEmpty?: boolean;
}

type ListOptions = LayoutOptions & {
  refresh?: () => Promise<(string | ListItem)[]>;
  resolveOn?: () => Promise<string | null | undefined>;
  defaultValue?: number;
  lockable?: boolean;
  footerText?: string | { label: string; center?: boolean };
}

export type ListItem = {
  label: string;
  value?: string;
  badge?: string;
  badgeColor?: "red" | "green" | "yellow";
  blocked?: boolean;
}

export type LogType = "info" | "success" | "warning" | "error";

type Render = (
  draw: () => string,
  handleKey: (key: string) => void,
  layoutOptions?: LayoutOptions
) => {
  cleanup: () => void;
  rerender: () => void;
};

export default class UI {
  private static altScreen = false;
  private static loaderInterval: NodeJS.Timeout | null = null;
  private static readonly PADDING = 1;
  private static readonly BG = "\x1B[48;5;235m";
  private static readonly FG = "\x1B[38;5;255m";
  private static readonly RST = "\x1B[39m\x1B[49m";
  private static readonly LOADER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  static readonly START_ART = `
╔═╦═╗     ╗  ╦        ╗                 ╦  ╦     ╦  
║ ║ ║     ║  ║  o     ║                 ║  ║     ║   
║ ║ ║ ╦ ╦ ║ ═╬═ ╦ ╔═╗ ║ ╔═╗ ╦ ╦ ╔═╗ ╦═╗ ╠══╣ ╦ ╦ ╠═╗ 
║ ║ ║ ║ ║ ║  ║  ║ ║ ║ ║ ╔═╣ ║ ║ ╠═╝ ║   ║  ║ ║ ║ ║ ║ 
╩ ╩ ╩ ╚═╝ ╩  ╚╝ ╩ ╠═╝ ╩ ╚═╚ ╚═╣ ╚═╝ ╩   ╩  ╩ ╚═╝ ╚═╝ 
                  ║           ║                      
                  ╩         ╚═╝                      `;

  private static cols(): number {
    return process.stdout.columns || 80;
  }

  private static async pasteFromClipboard() {
    if (process.platform !== "win32") return "";
    return execSync(`powershell -NoProfile -NonInteractive -Command "Get-Clipboard"`).toString();
  };

  static textColor(str: string, type: LogType) {
    return `\x1b[3${type === "success" ? 2 : type === "warning" ? 3 : type === "error" ? 1 : 4}m\x1b[1m${str}\x1b[0m`;
  };

  private static wrap(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const segment of text.split("\n")) {
      const plain = segment.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
      if (plain.length <= maxWidth) {
        lines.push(segment);
      } else {
        let visualLen = 0;
        let line = "";
        for (let i = 0; i < segment.length; i++) {
          if (segment[i] === '\x1B') {
            const end = segment.indexOf('m', i);
            line += segment.slice(i, (end !== -1 ? end : i) + 1);
            if (end !== -1) i = end;
            continue;
          }
          line += segment[i]!;
          visualLen++;
          if (visualLen >= maxWidth) {
            lines.push(line);
            line = "";
            visualLen = 0;
          }
        }
        if (line) lines.push(line);
      }
    }
    return lines;
  }

  static spinner(): { stop: () => void } {
    let i = 0;
    const id = setInterval(() => {
      process.stderr.write(`\r\x1B[2K\x1B[38;5;27m${UI.LOADER_FRAMES[i++ % 10]}\x1B[39m`);
    }, 80);

    return {
      stop: () => {
        clearInterval(id);
        process.stderr.write(`\r\x1B[2K`);
      }
    };
  }

  static loader(text?: string): { stop: () => void } {
    let frame = 0;
    const W = 30;
    const BLUE = "\x1B[38;5;27m";
    const RST_FG = "\x1B[39m";
    const bounce: string[][] = [];
    for (let i = 0; i <= W - 2; i++) {
      const l = " ".repeat(i);
      const r = " ".repeat(W - i - 2);
      bounce.push([l + `${BLUE}██${RST_FG}` + r, l + `${BLUE}██${RST_FG}` + r]);
    }
    for (let i = W - 3; i > 0; i--) {
      const l = " ".repeat(i);
      const r = " ".repeat(W - i - 2);
      bounce.push([l + `${BLUE}██${RST_FG}` + r, l + `${BLUE}██${RST_FG}` + r]);
    }

    const totalW = W + 2;

    const draw = () => {
      const indent = " ".repeat(Math.max(0, Math.floor((UI.cols() - totalW) / 2)));
      const [r1, r2] = bounce[frame % bounce.length]!;
      const box = [
        "╔" + "═".repeat(W) + "╗",
        "║" + " ".repeat(W) + "║",
        "║" + r1 + "║",
        "║" + r2 + "║",
        "║" + " ".repeat(W) + "║",
        "╚" + "═".repeat(W) + "╝",
      ].map(l => indent + l).join("\n");
      if (text) {
        return `${indent}\x1B[1m${text}\x1B[22m\n\n${box}`;
      }
      return box;
    };

    const { cleanup, rerender } = UI.render(draw, () => { }, { backText: null });

    const id = setInterval(() => {
      frame++;
      rerender();
    }, 40);

    UI.loaderInterval = id;

    return {
      stop: () => {
        clearInterval(id);
        UI.loaderInterval = null;
        cleanup();
        UI.restoreMainScreen();
      }
    };
  }

  static createAltScreen() {
    if (!UI.altScreen) {
      process.stdout.write("\x1B[?25l\x1B[?1049h");
      UI.altScreen = true;
    }
  }

  static restoreMainScreen() {
    if (UI.loaderInterval) {
      clearInterval(UI.loaderInterval);
      UI.loaderInterval = null;
    }
    if (UI.altScreen) {
      try {
        process.stdout.removeAllListeners("resize");
        process.stdin.removeAllListeners("data");
        process.stdin.setRawMode(false);
        process.stdout.write("\x1B[?1049l\x1B[?25h");
      } catch { }
      UI.altScreen = false;
    }
  }

  private static render: Render = (draw, handleKey, { title, desc, backText, action } = {}) => {
    const TITLE_WIDTH = 50;
    const stdin = process.stdin;

    try { stdin.setRawMode(true); } catch { };
    stdin.resume();
    stdin.setEncoding("utf8");

    UI.createAltScreen();

    const renderFrame = () => {
      const c = UI.cols();
      const r = process.stdout.rows || 24;

      if (c < 82 || r < 24) {
        const msg = `Terminal too small — need 82x24, have ${c}x${r}`;
        const pad = Math.max(0, Math.floor((r - 1) / 2));
        process.stdout.write("\x1B[2J\x1B[H");
        process.stdout.write("\n".repeat(pad));
        process.stdout.write(" ".repeat(Math.max(0, Math.floor((c - msg.length) / 2))));
        process.stdout.write("\x1B[41m\x1B[97m" + msg + "\x1B[39m\x1B[49m\n");
        return;
      }

      const backLine = `\x1B[2m← ${backText || "Back"} (Esc)\x1B[22m`;

      const contentLines: string[] = [];

      if (title) {
        const lines = title.includes("\n") ? title.split("\n") : UI.wrap(title, TITLE_WIDTH);
        if (title.includes("\n")) {
          const blockWidth = Math.max(...lines.map(l => l.length));
          const indent = " ".repeat(Math.max(0, Math.floor((UI.cols() - blockWidth) / 2)));
          lines.forEach((l) => {
            contentLines.push(`${indent}${l}`);
          });
        } else {
          lines.forEach((l, i) => {
            const indent = " ".repeat(Math.max(0, Math.floor((UI.cols() - TITLE_WIDTH) / 2)));
            contentLines.push(i === 0 ? `${indent}\x1B[1m${l}\x1B[22m` : `${indent}${l}`);
          });
        }
      }
      if (desc) {
        const lines = UI.wrap(desc, TITLE_WIDTH);
        lines.forEach((l) => {
          const indent = " ".repeat(Math.max(0, Math.floor((UI.cols() - TITLE_WIDTH) / 2)));
          contentLines.push(`${indent}\x1B[2m${l}\x1B[22m`);
        });
      }
      if (title || desc) contentLines.push("");

      const rawList = draw();
      if (rawList) {
        contentLines.push(...rawList.split("\n"));
      }

      const termHeight = process.stdout.rows || 24;
      const hasBack = backText !== null;
      const topPadding = Math.max(0, Math.floor((termHeight - (hasBack ? 1 : 0) - contentLines.length) / 2));

      let frame = "\x1B[?2026h\x1B[2J\x1B[H";
      if (hasBack) {
        frame += backLine;
        if (action) {
          const actionText = `${action.label} (Ctrl+O)`;
          frame += `\x1B[${c - actionText.length + 1}G\x1B[2m${actionText}\x1B[22m`;
        }
        frame += "\n";
      }
      frame += "\n".repeat(topPadding);
      frame += contentLines.join("\n");
      frame += "\n\n\x1B[?2026l";
      process.stdout.write(frame);
    };

    renderFrame();

    const onData = async (key: string) => {
      if (key === "\u000f" && action) {
        stdin.removeListener("data", onData);
        process.stdout.removeListener("resize", renderFrame);
        await action.run();
        renderFrame();
        handleKey(key);
        process.stdout.on("resize", renderFrame);
        stdin.on("data", onData);
        return;
      }
      handleKey(key);
    };

    process.stdout.on("resize", renderFrame);
    stdin.on("data", onData);

    const cleanup = () => {
      process.stdout.removeListener("resize", renderFrame);
      stdin.removeListener("data", onData);
    };

    return { cleanup, rerender: renderFrame };
  }

  static list(inputItems: (string | ListItem)[], layoutOptions?: ListOptions): Promise<{ value: string; index: number; cancelled: boolean }> {
    const toItem = (i: string | ListItem): ListItem => typeof i === "string" ? { label: i } : i;
    const items: ListItem[] = inputItems.map(toItem);
    return new Promise((resolve) => {
      let selectedIndex = layoutOptions?.defaultValue !== undefined
        ? Math.min(Math.max(0, layoutOptions.defaultValue), Math.max(0, items.length - 1))
        : 0;
      if (selectedIndex < 0 || selectedIndex >= items.length) selectedIndex = 0;
      let scrollOffset = 0;
      let filter = "";
      const CURSOR_BG = "\x1B[48;5;27m";
      const MAX_VISIBLE = 10;
      let keyHandler: (key: string) => void = () => { };

      const draw = () => {
        const LIST_WIDTH = 50;
        const SEL_BG = "\x1B[48;5;27m";
        const SEL_FG = "\x1B[38;5;255m";
        const TEXT_AREA = LIST_WIDTH - 2 * UI.PADDING;
        const listLeft = Math.floor((UI.cols() - LIST_WIDTH) / 2);
        const listIndent = " ".repeat(Math.max(0, listLeft));
        const emptyLine = `${listIndent}${UI.BG}${UI.FG}${" ".repeat(LIST_WIDTH)}${UI.RST}`;

        const pool = filter ? items.filter(i => i.label.toLowerCase().includes(filter.toLowerCase())) : items;
        if (selectedIndex >= pool.length) selectedIndex = Math.max(0, pool.length - 1);

        const scrollNeeded = pool.length > MAX_VISIBLE;
        const searchVisible = items.length > 6;

        const searchPrefix = "> ";
        const maxSearchWidth = LIST_WIDTH - 2 * UI.PADDING - searchPrefix.length - 1;
        const displayFilter = filter.length > maxSearchWidth
          ? ".." + filter.slice(-(maxSearchWidth - 2))
          : filter;
        const searchRightFill = Math.max(0, LIST_WIDTH - UI.PADDING - searchPrefix.length - displayFilter.length - 1);
        const searchLine = searchVisible
          ? `${listIndent}${UI.BG}${UI.FG}${" ".repeat(UI.PADDING)}\x1B[2m${searchPrefix}\x1B[22m${displayFilter}${CURSOR_BG} ${UI.BG}${UI.FG}${" ".repeat(searchRightFill)}${UI.RST}`
          : "";

        if (scrollNeeded) {
          if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
          if (selectedIndex >= scrollOffset + MAX_VISIBLE) scrollOffset = selectedIndex - MAX_VISIBLE + 1;
        }

        const visibleItems = scrollNeeded ? pool.slice(scrollOffset, scrollOffset + MAX_VISIBLE) : pool;

        const scrollbarChars: string[] = [];
        if (scrollNeeded) {
          const trackHeight = MAX_VISIBLE;
          const thumbSize = Math.max(1, Math.round((trackHeight / pool.length) * trackHeight));
          const maxScroll = pool.length - trackHeight;
          const ts = maxScroll > 0
            ? Math.round((scrollOffset / maxScroll) * (trackHeight - thumbSize))
            : 0;
          const te = Math.min(ts + thumbSize, trackHeight);
          for (let i = 0; i < trackHeight; i++) {
            scrollbarChars.push(i >= ts && i < te ? "\u2588" : "\u2502");
          }
        }

        const scrollBarWidth = scrollNeeded ? 2 : 0;

        const itemLines = visibleItems.flatMap((item, index) => {
          const actualIndex = scrollNeeded ? scrollOffset + index : index;
          const textWidth = TEXT_AREA - scrollBarWidth;
          const label = item.label;
          const wrapped = label.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").length > textWidth ? UI.wrap(label, textWidth) : [label];
          return wrapped.map((l, i) => {
            const isSelected = actualIndex === selectedIndex && i === 0;
            const bg = isSelected ? SEL_BG : UI.BG;
            const fg = isSelected ? SEL_FG : UI.FG;

            const plain = l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
            const BADGE_STYLE = item.badgeColor === "green" ? "\x1B[32m\x1B[1m" : item.badgeColor === "yellow" ? "\x1B[33m\x1B[1m" : "\x1B[48;5;196m\x1B[38;5;255m";
            const displayBadge = item.badge || (item.blocked ? "locked" : undefined);
            const truncatedBadge = displayBadge && displayBadge.length > 7 ? displayBadge.slice(0, 7) + ".." : displayBadge;
            const badgeText = truncatedBadge && i === 0 ? ` ${BADGE_STYLE}${truncatedBadge}${bg}${fg}` : "";
            const rightFill = Math.max(0, LIST_WIDTH - UI.PADDING - plain.length - scrollBarWidth - (truncatedBadge && i === 0 ? truncatedBadge.length + 1 : 0));
            const style = i === 0 ? "\x1B[1m" : "";
            const resetStyle = i === 0 ? "\x1B[22m" : "";

            let line = `${listIndent}${bg}${fg}${" ".repeat(UI.PADDING)}${style}${l}\x1B[0m${bg}${fg}${resetStyle}${" ".repeat(rightFill)}${badgeText}`;
            if (scrollNeeded) {
              line += `${scrollbarChars[index] ?? "\u2502"} `;
            }
            line += UI.RST;
            return line;
          });
        });

        const hint = "\u2191 \u2193 to move";
        const hintIndent = " ".repeat(Math.max(0, Math.floor((UI.cols() - hint.length) / 2)));
        const listLines = [(searchVisible ? searchLine : emptyLine), ...itemLines, emptyLine, `${hintIndent}\x1B[2m${hint}\x1B[22m`];
        if (layoutOptions?.footerText) {
          const f = typeof layoutOptions.footerText === "string" ? layoutOptions.footerText : layoutOptions.footerText.label;
          const center = typeof layoutOptions.footerText === "string" ? true : (layoutOptions.footerText.center ?? true);
          const fi = center ? " ".repeat(Math.max(0, Math.floor((UI.cols() - f.length) / 2))) : "";
          listLines.push(`${fi}\x1B[2m${f}\x1B[22m`);
        }
        return listLines.join("\n");
      };

      const { cleanup: origCleanup, rerender } = UI.render(draw, (key) => keyHandler(key), layoutOptions);
      let cleanup = origCleanup;

      if (layoutOptions?.refresh) {
        const refreshInterval = async () => {
          const newItems = await layoutOptions.refresh!();
          const newNormalized = newItems.map(toItem);
          if (JSON.stringify(newNormalized) !== JSON.stringify(items)) {
            items.length = 0;
            items.push(...newNormalized);
            rerender();
          }
        };
        refreshInterval();
        const id = setInterval(refreshInterval, 3000);
        cleanup = () => { clearInterval(id); origCleanup(); };
      }

      if (layoutOptions?.resolveOn) {
        const resolvePoll = async () => {
          const resolveValue = await layoutOptions.resolveOn!();
          if (resolveValue) {
            cleanup();
            resolve({ value: resolveValue, index: -1, cancelled: false });
          }
        };
        resolvePoll();
        const resolveId = setInterval(resolvePoll, 3000);
        const origCleanup2 = cleanup;
        cleanup = () => { clearInterval(resolveId); origCleanup2(); };
      }

      keyHandler = (key) => {
        const pool = filter ? items.filter(i => i.label.toLowerCase().includes(filter.toLowerCase())) : items;

        if (key === "\u001b") {
          cleanup();
          resolve({ value: "", index: selectedIndex, cancelled: true });
          return;
        }
        if (layoutOptions?.lockable) {
          if (key === "\u000f") {
            const item = pool[selectedIndex];
            if (item) {
              if (item.blocked) {
                delete item.blocked;
                delete item.badge;
              } else {
                item.blocked = true;
              }
              rerender();
            }
            return;
          }
          if (key === "\r" || key === "\r\n") {
            if (pool.length === 0) return;
            if (pool[selectedIndex]?.blocked) return;
          }
        }
        if (key === "\r" || key === "\r\n") {
          if (pool.length === 0) return;
          if (pool[selectedIndex]?.blocked) return;
          cleanup();
          resolve({ value: pool[selectedIndex]!.value ?? pool[selectedIndex]!.label, index: selectedIndex, cancelled: false });
          return;
        }
        if (key === "\u001b[A") {
          selectedIndex = selectedIndex > 0 ? selectedIndex - 1 : pool.length - 1;
          rerender();
          return;
        }
        if (key === "\u001b[B") {
          selectedIndex = selectedIndex < pool.length - 1 ? selectedIndex + 1 : 0;
          rerender();
          return;
        }
        if (items.length > 6) {
          if (key.length === 1 && /[a-zA-Z0-9 ._-]/.test(key)) {
            filter += key;
            selectedIndex = 0;
            scrollOffset = 0;
            rerender();
            return;
          }
          if (key === "\x7f" || key === "\b") {
            if (filter.length > 0) {
              filter = filter.slice(0, -1);
              selectedIndex = 0;
              scrollOffset = 0;
              rerender();
            }
            return;
          }
        }
      };
    });
  }

  private static badgeInterval: NodeJS.Timeout | null = null;
  private static badgeFlag: { value: boolean } | null = null;
  private static readonly badgeKeyHandler = (key: string) => {
    if (key === "\u000f" && UI.badgeFlag) UI.badgeFlag.value = true;
  };

  static startBadge(text: string, flag?: { value: boolean }) {
    UI.stopBadge();
    UI.badgeFlag = flag ?? null;

    const draw = () => {
      if (UI.altScreen) return;
      const badge = `\x1B[44m\x1B[97m ${text} \x1B[39m\x1B[49m`;
      const cols = UI.cols();
      process.stdout.write(`\x1B7\x1B[1;${Math.max(1, cols - text.length - 1)}H${badge}\x1B8`);
    };
    draw();
    UI.badgeInterval = setInterval(draw, 200);

    try { process.stdin.setRawMode(true); } catch { }
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", UI.badgeKeyHandler);
  }

  static stopBadge() {
    if (UI.badgeInterval) {
      clearInterval(UI.badgeInterval);
      UI.badgeInterval = null;
    }
    try {
      process.stdin.removeListener("data", UI.badgeKeyHandler);
      process.stdin.setRawMode(false);
    } catch { }
    UI.badgeFlag = null;
  }

  static input(layoutOptions?: InputOptions): Promise<{ value: string; cancelled: boolean }> {
    const { defaultValue, maxLen, filter, validate, allowEmpty } = layoutOptions ?? {};
    return new Promise((resolve) => {
      let value = defaultValue ?? "";
      let cursorPos = value.length;
      let triedSubmit = false;
      let keyHandler: (key: string) => void = () => { };

      const MAX_LEN = maxLen ?? 50;
      const CURSOR_BG = "\x1B[48;5;27m";

      const getError = (): string | null => {
        if (!allowEmpty && value.length <= 3) return "Must be more than 3 symbols";
        if (validate) return validate(value);
        return null;
      };

      const draw = () => {
        const inputWidth = Math.min(MAX_LEN, UI.cols() - 4);
        const left = Math.floor((UI.cols() - inputWidth) / 2);
        const indent = " ".repeat(Math.max(0, left));
        const emptyLine = `${indent}${UI.BG}${UI.FG}${" ".repeat(inputWidth)}${UI.RST}`;

        let offset = 0;
        if (cursorPos >= inputWidth) {
          offset = cursorPos - inputWidth + 1;
        }
        if (offset > 0 && offset + inputWidth > value.length) {
          offset = Math.max(0, value.length - inputWidth);
        }
        if (offset + inputWidth > value.length + 1 && value.length < MAX_LEN) {
          offset = Math.max(0, value.length + 1 - inputWidth);
        }

        let visible = "";
        for (let i = 0; i < inputWidth; i++) {
          const charIndex = offset + i;
          const isCursor = charIndex === cursorPos;

          if (charIndex < value.length) {
            visible += isCursor
              ? `${CURSOR_BG}\x1B[38;5;15m${value[charIndex]!}${UI.BG}${UI.FG}`
              : value[charIndex]!;
          } else {
            visible += isCursor
              ? `${CURSOR_BG} ${UI.BG}${UI.FG}`
              : `\x1B[2m_\x1B[22m`;
          }
        }

        const line = `${indent}${UI.BG}${UI.FG}${visible}${UI.RST}`;

        const error = getError();
        const errorLine = triedSubmit && error
          ? `${indent}\x1B[38;5;196m* ${error}\x1B[39m`
          : null;

        const parts = [emptyLine, line, emptyLine];
        if (errorLine) parts.push(errorLine);
        return parts.join("\n");
      };

      const { cleanup, rerender } = UI.render(draw, (key) => keyHandler(key), layoutOptions);

      keyHandler = (key) => {
        if (key === "\x16") {
          UI.pasteFromClipboard().then(paste => {
            if (!paste) return;
            const sanitized = [...paste].filter(c => {
              const code = c.charCodeAt(0);
              return code >= 33 && code <= 126 && (!filter || filter.test(c));
            }).join("");
            const available = MAX_LEN - value.length;
            const sliced = sanitized.slice(0, available);
            if (sliced.length > 0) {
              value = value.slice(0, cursorPos) + sliced + value.slice(cursorPos);
              cursorPos += sliced.length;
              rerender();
            }
          });
          return;
        }
        if (key === "\u001b") {
          cleanup();
          resolve({ value: "", cancelled: true });
          return;
        }
        if (key === "\r" || key === "\r\n") {
          if (getError()) {
            triedSubmit = true;
            rerender();
            return;
          }
          cleanup();
          resolve({ value, cancelled: false });
          return;
        }
        if (key === "\x7f" || key === "\b") {
          if (cursorPos > 0) {
            value = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
            cursorPos--;
            rerender();
          }
          return;
        }
        if (key === "\u001b[D") {
          if (cursorPos > 0) {
            cursorPos--;
            rerender();
          }
          return;
        }
        if (key === "\u001b[C") {
          if (cursorPos < value.length) {
            cursorPos++;
            rerender();
          }
          return;
        }
        if (key.length > 1 && key.charCodeAt(0) !== 27) {
          const sanitized = [...key].filter((c) => {
            const code = c.charCodeAt(0);
            return code >= 33 && code <= 126 && (!filter || filter.test(c));
          }).join("");
          if (sanitized.length === 0) return;
          const available = MAX_LEN - value.length;
          const paste = sanitized.slice(0, available);
          if (paste.length > 0) {
            value = value.slice(0, cursorPos) + paste + value.slice(cursorPos);
            cursorPos += paste.length;
            rerender();
          }
          return;
        }
        if (key.length === 1 && key.charCodeAt(0) >= 33 && value.length < MAX_LEN && (!filter || filter.test(key))) {
          value = value.slice(0, cursorPos) + key + value.slice(cursorPos);
          cursorPos++;
          rerender();
          return;
        }
      };
    });
  }
}
