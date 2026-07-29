import type { ChildProcessWithoutNullStreams } from "child_process";
import { spawn } from "child_process";
import { setTimeout as setTimeoutPromise } from "timers/promises";
import { join } from "path";
import { IS_WIN32, LINUX_SHELL, INSTANCES_DIR } from "./constants";
import type { TryCatch, Run } from "./types";
import { access, constants } from "fs/promises";
import UI, { type LogType } from "./managers/ui";

export const run: Run = async (commands, options) => {
  const result: string[] = [],
    commandsArray: string[] = Array.isArray(commands) ? commands : [commands],
    spawnFn = (c: string) => {
      const isTTY = options?.inherit && process.stdin.isTTY;
      const childEnv = { ...process.env } as Record<string, string>;
      if (options?.gitSshKeyName) {
        const key = join(INSTANCES_DIR, options.gitSshKeyName, "deploy_key").replace(/\\/g, "/");
        childEnv['GIT_SSH_COMMAND'] = `ssh -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -i ${key}`;
      }
      const child = spawn(c, {
        shell: IS_WIN32 ? true : LINUX_SHELL,
        cwd: options?.cwd,
        env: childEnv,
        ...(isTTY ? { stdio: ['inherit', 'pipe', 'pipe'] as const } : {})
      }) as ChildProcessWithoutNullStreams;
      return child;
    };

  const executeCmd = (cmd: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const child = spawnFn(cmd);
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

      child.on("error", reject);
      child.on("close", (code) => {
        return code === 0
          ? resolve(stdout.trim())
          : reject(
            new Error(
              stderr.trim() || `${cmd}\nfailed with exit code ${code}`
            )
          );
      });
    });
  };

  for (const cmd of commandsArray) {
    if (cmd.startsWith("git ")) {
      result.push(await retryRun(() => executeCmd(cmd)));
    } else {
      result.push(await executeCmd(cmd));
    }
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

export const log = (msg: string, type?: LogType) => {
  return console.log(`\r${type ? UI.textColor(msg, type) : msg}`);
};

export const throwErr = (msg?: string): never => {
  throw new Error(msg && UI.textColor(msg.replace("Error: ", ""), "error"));
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

export const sudo = (cmd: string) => {
  return IS_WIN32 ? cmd : `sudo ${cmd}`;
};
