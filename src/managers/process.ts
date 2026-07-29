import { IS_WIN32, USER_DIR, APP_NAME, APP_VERSION } from "../constants";
import { isSuccess, log, run, throwErr, tryCatch } from "../utils";
import { createInterface } from "readline";
import UI from "./ui";
import Git from "./git";
import Hosting from "./hosting";
import Java from "./java";

export default class Process {
  private static closing = false;

  private static async killPrevious() {
    await tryCatch(async () => {
      let pids: number[];
      if (IS_WIN32) {
        const out = await run(`tasklist /FI "IMAGENAME eq ${APP_NAME}.exe" /NH`);
        if (out.includes("No tasks")) return;
        pids = out.trim().split("\n").filter(Boolean).map(l => parseInt(l.trim().split(/\s+/)[1]!, 10)).filter(n => !isNaN(n) && n !== process.pid);
      } else {
        const out = await run(`pgrep -x "${APP_NAME}" || true`);
        if (out.trim() === "") return;
        pids = out.trim().split("\n").filter(Boolean).map(Number).filter(n => n !== process.pid);
      }
      if (pids.length === 0) return;

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(UI.textColor(`Detected another ${APP_NAME} app running\nKill it and continue here? (y/n): `, "warning"), (ans) => {
          rl.close();
          resolve(ans.trim().toLowerCase());
        });
      });

      if (answer !== "y") {
        log("Exiting...", "info");
        await Process.stop();
      }

      for (const pid of pids) {
        await run(IS_WIN32 ? `taskkill /F /PID ${pid} & ver>nul` : `kill -9 ${pid} || true`);
      }
    }, "Failed to kill previous MultiplayerHub instance");
  }

  private static async ensureAdmin() {
    const isAdmin = await isSuccess(async () => await run("net session"));
    if (isAdmin) return;
    throwErr(`You don't have admin rights!\nPlease start the program as an admin`);
  }

  static async init() {
    process.stdout.write(`\x1b]0;${APP_NAME} v${APP_VERSION}\x07`);
    process.chdir(USER_DIR);

    if (IS_WIN32) await Process.ensureAdmin();
    await Process.killPrevious();

    process.on("uncaughtException", err => {
      UI.restoreMainScreen();
      log("Uncaught Exception: " + err, "error");
      Process.stop();
    });
    process.on("unhandledRejection", reason => {
      UI.restoreMainScreen();
      log("Unhandled Rejection: " + reason, "error");
      Process.stop();
    });

    const { emitWarning } = process;
    process.emitWarning = (warning, ...args) => {
      if (args[0] === 'ExperimentalWarning') return;
      return emitWarning(warning, ...args as (NodeJS.EmitWarningOptions | undefined)[]);
    };
  };

  static async pause() {
    await new Promise<void>(async (resolve) => {
      await tryCatch(() => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        rl.question(UI.textColor("Press Enter to continue...", "warning"), () => {
          rl.close();
          resolve();
        });
      }, "Error while pausing the app", true);
    });
  }

  static async stop() {
    if (Process.closing) return;
    Process.closing = true;
    UI.restoreMainScreen();
    UI.stopBadge();

    await Java.kill();
    Git.worldDisableRepeatedPush();
    await Hosting.close();

    await Process.pause();
    process.exit(0);
  }
}
