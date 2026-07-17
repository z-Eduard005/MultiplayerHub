import { cp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { exists, randomNum, run, log, tryCatch, throwErr } from "../utils";
import { USER_NAME, INSTANCES_DIR } from "../constants";
import { join } from "path";
import GH from "./gh";
import App from "./app";

export default class Git {
  private static readonly PUSH_INTERVAL_MS = 3 * 60 * 1000;
  private static readonly SERVER_GITIGNORE = "/world/\n";
  private static readonly WORLD_GITIGNORE = "*.lock\n*.tmp\n*.dat_old\n";
  static nodeWorldPushInterval: NodeJS.Timeout;

  static async initServer(serverName: string) {
    const serverDir = join(INSTANCES_DIR, serverName, "server");
    const deployKeyPath = join(INSTANCES_DIR, serverName, "deploy_key");
    const posixPath = deployKeyPath.replace(/\\/g, "/");

    await tryCatch(async () => {
      await rm(join(serverDir, ".git"), { recursive: true, force: true });
      await writeFile(join(serverDir, ".gitignore"), Git.SERVER_GITIGNORE);
      await run("git init -b server", { cwd: serverDir });

      await rm(deployKeyPath, { force: true });
      await rm(deployKeyPath + ".pub", { force: true });
      await run(`ssh-keygen -t ed25519 -N "" -f "${posixPath}"`);

      const repoUrl = await GH.repoCreate(serverName);
      const pubKey = await readFile(deployKeyPath + ".pub", "utf8");
      await GH.addDeployKey(serverName, pubKey.trim());

      await run(
        [
          `git remote add origin ${repoUrl}`,
          "git add -A",
          'git commit --allow-empty -m "init"',
          "git push --force origin server"
        ],
        { cwd: serverDir, inherit: true, gitSshKeyName: serverName }
      );

      await App.updateInstance(serverName, { repoUrl });
    }, "Error during server directory initialization");
  }

  static async initWorld(serverName: string, worldPath?: string) {
    const worldDir = join(INSTANCES_DIR, serverName, "server", "world");

    await tryCatch(async () => {
      const inst = await App.getInstance(serverName);
      const repoUrl = inst?.repoUrl;
      if (!repoUrl) throwErr("No server url found. Please create a server first");

      await rm(worldDir, { recursive: true, force: true });
      await mkdir(worldDir, { recursive: true });

      if (worldPath) {
        let invalidPath = true;

        const levelDatPath = join(worldPath, "level.dat");
        const regionDirPath = join(worldPath, "region");
        if (await exists(levelDatPath) && await exists(regionDirPath)) {
          invalidPath = false;
        }

        if (invalidPath) {
          log("Invalid world folder. Skipping...", "warning");
        } else {
          await cp(worldPath, worldDir, { recursive: true, force: true });
        }
      }

      await writeFile(join(worldDir, ".gitignore"), Git.WORLD_GITIGNORE);
      await run(
        [
          "git init -b world",
          `git remote add origin ${repoUrl}`,
          "git add -A",
          'git commit --allow-empty -m "init"',
          "git push --force origin world"
        ],
        { cwd: worldDir, inherit: true, gitSshKeyName: serverName }
      );

    }, "Error during world directory initialization");
  }

  static worldEnableRepeatedPush(serverName: string) {
    Git.nodeWorldPushInterval = setInterval(async () => {
      await Git.push("world", serverName);
      log("The world has been sent to the cloud", "info");
    }, Git.PUSH_INTERVAL_MS);
  }

  static worldDisableRepeatedPush() {
    clearInterval(Git.nodeWorldPushInterval)
  }

  static async push(branch: "server" | "world", serverName: string) {
    const serverDir = join(INSTANCES_DIR, serverName, "server");
    const worldDir = join(serverDir, "world");

    await tryCatch(async () => {
      await run(
        [
          "git add -A",
          `git commit --allow-empty --amend -m "${USER_NAME + randomNum(6)}-update"`,
          `git push --force origin ${branch}`,
        ],
        { inherit: true, cwd: branch === "server" ? serverDir : worldDir, gitSshKeyName: serverName }
      );
    }, `Failed to push ${branch} updates to the cloud (check your internet)`);
  }

  static async syncWorld(serverName: string) {
    const worldDir = join(INSTANCES_DIR, serverName, "server", "world");
    log("World synchronization...", "info");

    await tryCatch(async () => {
      await run(
        "git -c credential.helper= fetch --depth 1 origin world",
        { inherit: true, cwd: worldDir, gitSshKeyName: serverName }
      );

      const unstagedChanges = await run("git status --porcelain", { cwd: worldDir });
      const [localHead, remoteHead] = await run(
        ["git rev-parse HEAD", "git rev-parse FETCH_HEAD"],
        { cwd: worldDir }
      );

      if (unstagedChanges.length !== 0 && localHead === remoteHead) {
        await Git.push("world", serverName);
      } else if (localHead !== remoteHead) {
        await run("git reset --hard FETCH_HEAD", { inherit: true, cwd: worldDir });
      }
    }, "Failed world synchronization");
  };

  private static async ensureRepo(dir: string, branch: string, url: string, serverName: string) {
    if (!await exists(join(dir, ".git"))) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await run(
        [
          `git init -b ${branch}`,
          `git remote add origin ${url}`,
          `git commit --allow-empty -m "init"`
        ],
        { cwd: dir, gitSshKeyName: serverName }
      );
    }
  }

  static async fetchInstanceData(serverName: string) {
    const inst = await App.getInstance(serverName);
    if (!inst) return;

    const serverDir = join(INSTANCES_DIR, serverName, "server");
    const worldDir = join(serverDir, "world");
    const repoUrl = inst.repoUrl;
    if (!repoUrl) throwErr(`No repo URL found for ${serverName} server`);

    if (inst.owner !== "me") {
      log("Server synchronization...", "info");
      await tryCatch(async () => {
        await Git.ensureRepo(serverDir, "server", repoUrl!, serverName);
        const existsIgnoreFile = await exists(join(serverDir, ".gitignore"));
        if (!existsIgnoreFile) await writeFile(join(serverDir, ".gitignore"), Git.SERVER_GITIGNORE);

        await run(
          ["git -c credential.helper= fetch --depth 1 origin server", "git reset --hard origin/server"],
          { inherit: true, cwd: serverDir, gitSshKeyName: serverName }
        );
      }, "Failed server synchronization");
    }

    log("World synchronization...", "info");
    await tryCatch(async () => {
      await Git.ensureRepo(worldDir, "world", repoUrl!, serverName);
      const existsIgnoreFile = await exists(join(worldDir, ".gitignore"));
      if (!existsIgnoreFile) await writeFile(join(worldDir, ".gitignore"), Git.WORLD_GITIGNORE);

      await Git.syncWorld(serverName);
    }, "Failed world synchronization");
  }
}
