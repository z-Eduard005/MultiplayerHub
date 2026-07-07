import { cp, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { exists, randomNum, run, log, tryCatch, throwErr } from "../utils";
import { USER_NAME, INSTANCES_DIR } from "../constants";
import { join } from "path";
import GH from "./gh";
import App from "./app";

export default class Git {
  private static readonly PUSH_INTERVAL_MS = 30 * 60 * 1000;

  static worldInitialized = false;
  static nodeWorldPushInterval: NodeJS.Timeout;

  static async initServer(serverName: string) {
    const serverDir = join(INSTANCES_DIR, serverName, "server");
    const deployKeyPath = join(INSTANCES_DIR, serverName, "deploy_key");
    const posixPath = deployKeyPath.replace(/\\/g, "/");

    await tryCatch(async () => {
      await rm(join(serverDir, ".git"), { recursive: true, force: true });
      await writeFile(join(serverDir, ".gitignore"), "/world/\n");
      await run("git init -b server", { cwd: serverDir });

      // Generate SSH deploy key pair
      await rm(deployKeyPath, { force: true });
      await rm(deployKeyPath + ".pub", { force: true });
      await run(`ssh-keygen -t ed25519 -N "" -f "${posixPath}"`);

      // Create repo with gh and save to config
      const repoUrl = await GH.repoCreate(serverName);
      const pubKey = await readFile(deployKeyPath + ".pub", "utf8");
      await GH.addDeployKey(serverName, pubKey.trim());

      // Set up remote + commit init
      process.env['GIT_SSH_COMMAND'] = `ssh -o StrictHostKeyChecking=accept-new -i ${posixPath}`;
      await run(
        [
          `git remote add origin ${repoUrl}`,
          "git add -A",
          'git commit --allow-empty -m "init"',
          "git push --force origin server"
        ],
        { cwd: serverDir, inherit: true }
      );

      // Save repoUrl to instance config
      await App.updateInstance(serverName, { repoUrl });
    }, "Error during server directory initialization");
  }

  static async initWorld(serverName: string, worldPath?: string) {
    const worldDir = join(INSTANCES_DIR, serverName, "server", "world");
    const deployKeyPath = join(INSTANCES_DIR, serverName, "deploy_key");
    const posixPath = deployKeyPath.replace(/\\/g, "/");

    await tryCatch(async () => {
      const inst = await App.getInstance(serverName);
      const repoUrl = inst?.repoUrl;
      if (!repoUrl) throwErr("No server url found. Please create a server first");

      await rm(join(worldDir, ".git"), { recursive: true, force: true });

      // Create world dir and copy files if path provided
      await mkdir(worldDir, { recursive: true });
      if (worldPath) {
        let invalidPath = true;

        const levelDatPath = join(worldPath, "level.dat");
        const regionDirPath = join(worldPath, "region");
        if (await exists(levelDatPath) && await exists(regionDirPath)) {
          invalidPath = false;
        }

        if (invalidPath) {
          log("Invalid world folder", "warning");
        } else {
          await rename(worldDir, worldDir + ".bak");
          await cp(worldPath, worldDir, { recursive: true, force: true });
        }
      }

      // Git init for world dir on branch "world" + push first commit to world branch
      process.env['GIT_SSH_COMMAND'] = `ssh -o StrictHostKeyChecking=accept-new -i ${posixPath}`;
      await run(
        [
          "git init -b world",
          `git remote add origin ${repoUrl}`,
          "git add -A",
          'git commit --allow-empty -m "init"',
          "git push --force origin world"
        ],
        { cwd: worldDir, inherit: true }
      );

    }, "Error during world directory initialization");
  }

  static worldEnableRepeatedPush(serverName: string, repoUrl: string) {
    Git.nodeWorldPushInterval = setInterval(async () => {
      await Git.pushWorld(serverName, repoUrl);
      log("The world has been sent to the cloud", "warning");
    }, Git.PUSH_INTERVAL_MS);
  }

  static worldDisableRepeatedPush() {
    clearInterval(Git.nodeWorldPushInterval)
  }

  static async pushWorld(serverName: string, repoUrl: string) {
    await tryCatch(async () => {
      const worldDir = join(INSTANCES_DIR, serverName, "server", "world");
      await run(
        [
          "git add -A",
          `git commit -m "${USER_NAME + randomNum(6)}-update"`,
          `git push -f ${repoUrl} --all`,
        ],
        { inherit: true, cwd: worldDir }
      );
    }, "Error sending world to the cloud (check your internet)");
  };

  static async syncWorld(serverName: string, repoUrl: string) {
    const worldDir = join(INSTANCES_DIR, serverName, "server", "world");
    log("World synchronization...", "info");
    await tryCatch(async () => {
      await run(`git -c credential.helper= fetch --depth 1 ${repoUrl}`, {
        inherit: true,
        cwd: worldDir,
      });
      const unstagedChanges = await run("git status --porcelain", { cwd: repoUrl });
      const [localHead, remoteHead] = await run(
        ["git rev-parse HEAD", "git rev-parse FETCH_HEAD"],
        { cwd: worldDir }
      );

      if (unstagedChanges.length !== 0 && localHead === remoteHead) {
        await Git.pushWorld(serverName, repoUrl);
      } else {
        await run("git reset --hard FETCH_HEAD", { inherit: true, cwd: worldDir });
      }
    }, "Failed world synchronization");
  };

  static async fetchServer(serverName: string, deployKeyPath: string) {
    const serverDir = join(INSTANCES_DIR, serverName, "server");
    log("Server synchronization...", "info");
    await tryCatch(async () => {
      const posixPath = deployKeyPath.replace(/\\/g, "/");
      process.env['GIT_SSH_COMMAND'] = `ssh -o StrictHostKeyChecking=accept-new -i ${posixPath}`;
      await run(
        [
          "git fetch --depth 1 origin server",
          "git reset --hard origin/server",
        ],
        { inherit: true, cwd: serverDir }
      );
    }, "Failed server synchronization");
  }

  static async pushServer(serverName: string, deployKeyPath: string) {
    const serverDir = join(INSTANCES_DIR, serverName, "server");
    const posixPath = deployKeyPath.replace(/\\/g, "/");
    await tryCatch(async () => {
      process.env['GIT_SSH_COMMAND'] = `ssh -o StrictHostKeyChecking=accept-new -i ${posixPath}`;
      await run(
        [
          "git add -A",
          'git commit --amend -m "snapshot"',
          "git push --force origin server",
        ],
        { inherit: true, cwd: serverDir }
      );
    }, "Failed to push server updates");
  }
}
