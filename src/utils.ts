import type { ChildProcessWithoutNullStreams } from "child_process";
import { spawn } from "child_process";
import { setTimeout as setTimeoutPromise } from "timers/promises";
import { IS_WIN32, LINUX_SHELL } from "./constants";
import type { TryCatch, Run, LogType } from "./types";
import { access, constants } from "fs/promises";

export const run: Run = async (commands, options) => {
  const result: string[] = [],
    commandsArray: string[] = Array.isArray(commands) ? commands : [commands],
    spawnFn = (c: string) => {
      const isTTY = options?.inherit && process.stdin.isTTY;
      const child = spawn(c, {
        shell: IS_WIN32 ? true : LINUX_SHELL,
        cwd: options?.cwd,
        env: process.env,
        ...(isTTY ? { stdio: ['inherit', 'pipe', 'pipe'] as const } : {})
      }) as ChildProcessWithoutNullStreams;
      return child;
    };

  for (const cmd of commandsArray) {
    result.push(
      await new Promise(async (resolve, reject) => {
        let child: ChildProcessWithoutNullStreams | undefined;
        if (cmd.startsWith("git ")) {
          child = await retryRun(() => {
            return spawnFn(cmd);
          });
        } else {
          child = spawnFn(cmd);
        }

        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
          if (options?.inherit) {
            process.stdout.write(chunk);
          }
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          if (options?.inherit) {
            process.stderr.write(chunk);
          }
        });

        child.on("close", (code) => {
          return code === 0
            ? resolve(stdout.trim())
            : reject(
              new Error(
                stderr.trim() || `${cmd}\nfailed with exit code ${code}`
              )
            );
        });
      })
    );
  }
  return (
    options?.inherit ? null : result.length === 1 ? result[0] : result
  ) as never;
};

export const isSuccess = async (fn: () => unknown) => {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
};

export const exists = (path: string) => {
  return isSuccess(async () => await access(path, constants.F_OK));
};

export const retryRun = async <Return>(fn: () => Return | Promise<Return>) => {
  let result, isFailed;
  for (const l = { maxAtts: 3, att: 1, interval: 2000 }; l.att <= l.maxAtts; l.att++) {
    result = await tryCatch(fn, async (err) => {
      isFailed = true;
      if (l.att === l.maxAtts) {
        throwErr(err);
      }
      await setTimeoutPromise(l.interval);
    });
    if (isFailed) {
      isFailed = false;
    } else {
      break;
    }
  }
  return result as Return;
};

export const color = (str: string, type: LogType) => {
  return `\x1b[3${type === "success" ? 2 : type === "warning" ? 3 : type === "error" ? 1 : 4}m\x1b[1m${str}\x1b[0m`;
};

export const log = (msg: string, type?: LogType) => {
  return console.log(`\r${type ? color(msg, type) : msg}`);
};

export const throwErr = (msg?: string): never => {
  throw new Error(msg && color(msg.replace("Error: ", ""), "error"));
};

export const tryCatch: TryCatch = async (fn, msgOrFn, isWarn) => {
  try {
    return await fn();
  } catch (err) {
    const stringErr = String(err);
    return (
      typeof msgOrFn !== "string"
        ? msgOrFn && (await msgOrFn(stringErr))
        : isWarn
          ? log(msgOrFn, "warning")
          : throwErr(`${msgOrFn}:\n${stringErr}`)
    ) as never;
  }
};

export const randomNum = (length: number) => {
  return Math.floor(Math.random() * Number("1e" + length.toFixed(0).replace("-", "")));
};

export const sudo = (cmd: string) => {
  return IS_WIN32 ? cmd : `sudo ${cmd}`;
};