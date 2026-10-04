import { appendFile, mkdir, readdir, rm, stat } from "fs/promises";
import { join } from "path";
import { APP_DIR, IS_WIN32 } from "../constants";
import { run } from "../utils";

export default class Logger {
  private static readonly DIR = join(APP_DIR, "logs");
  private static readonly KEEP = 10;
  private static file: string | null = null;
  private static queue: Promise<void> = Promise.resolve();
  private static origStdoutWrite: typeof process.stdout.write | null = null;
  private static origStderrWrite: typeof process.stderr.write | null = null;

  private static stripAnsi(text: string): string {
    return text.replace(/\[[0-9;]*[a-zA-Z]/g, "");
  }

  private static enqueue(line: string): void {
    if (!Logger.file) return;
    const file = Logger.file;
    Logger.queue = Logger.queue.then(() => appendFile(file, line, "utf8")).catch(() => undefined);
  }

  private static readonly SCREEN_CTRL = /\[(?:\?[0-9]+[hl]|[0-9;]*[HJK])/;

  static append(text: string): void {
    try {
      if (Logger.SCREEN_CTRL.test(text)) return;
      const clean = Logger.stripAnsi(text);
      if (clean === "") return;
      Logger.enqueue(clean);
    } catch { /* logging must never throw */ }
  }

  static entry(message: string): void {
    try {
      Logger.enqueue(`${Logger.stripAnsi(message)}\n`);
    } catch { /* logging must never throw */ }
  }

  static error(err: unknown): void {
    try {
      const detail = err instanceof Error ? (err.stack ?? String(err)) : String(err);
      Logger.enqueue(`${Logger.stripAnsi(detail)}\n`);
    } catch { /* logging must never throw */ }
  }

  private static async systemTimestamp(): Promise<string | null> {
    try {
      const out = await run(
        IS_WIN32
          ? `powershell -NoProfile -NonInteractive -Command "Get-Date -Format 'dd-MM-yyyy_HHmmss'"`
          : "date +%d-%m-%Y_%H%M%S"
      );
      const text = out.trim();
      return /^\d{2}-\d{2}-\d{4}_\d{6}$/.test(text) ? text : null;
    } catch {
      return null;
    }
  }

  private static dateTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const day = pad(now.getDate());
    const month = pad(now.getMonth() + 1);
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${day}-${month}-${now.getFullYear()}_${time}`;
  }

  private static async openNew(): Promise<void> {
    try {
      await mkdir(Logger.DIR, { recursive: true });
      const entries = await readdir(Logger.DIR).catch(() => [] as string[]);
      const logs = entries.filter((e) => /^\d{2}-\d{2}-\d{4}_\d+\.log$/.test(e));
      const withTime = await Promise.all(logs.map(async (e) => {
        const mtime = await stat(join(Logger.DIR, e)).then((s) => s.mtimeMs).catch(() => 0);
        return { e, mtime };
      }));
      withTime.sort((a, b) => a.mtime - b.mtime);
      while (withTime.length >= Logger.KEEP) {
        const oldest = withTime.shift();
        if (oldest) await rm(join(Logger.DIR, oldest.e), { force: true });
      }
      const stamp = (await Logger.systemTimestamp()) ?? Logger.dateTimestamp();
      Logger.file = join(Logger.DIR, `${stamp}.log`);
    } catch { /* logging must never throw */ }
  }

  private static wrapStdout(): void {
    if (Logger.origStdoutWrite) return;
    Logger.origStdoutWrite = process.stdout.write;
    const orig = Logger.origStdoutWrite;
    process.stdout.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
      Logger.append(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return Boolean(Reflect.apply(orig, process.stdout, [chunk, encoding, callback]));
    }) as typeof process.stdout.write;
  }

  private static wrapStderr(): void {
    if (Logger.origStderrWrite) return;
    Logger.origStderrWrite = process.stderr.write;
    const orig = Logger.origStderrWrite;
    process.stderr.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
      Logger.append(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return Boolean(Reflect.apply(orig, process.stderr, [chunk, encoding, callback]));
    }) as typeof process.stderr.write;
  }

  static capture(): void {
    try {
      Logger.wrapStdout();
      Logger.wrapStderr();
    } catch { /* logging must never throw */ }
  }

  static restore(): void {
    try {
      if (Logger.origStdoutWrite) {
        process.stdout.write = Logger.origStdoutWrite;
        Logger.origStdoutWrite = null;
      }
      if (Logger.origStderrWrite) {
        process.stderr.write = Logger.origStderrWrite;
        Logger.origStderrWrite = null;
      }
    } catch { /* logging must never throw */ }
  }

  static async init(): Promise<void> {
    await Logger.openNew();
    Logger.capture();
  }
}
