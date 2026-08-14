import { cp, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { exists, run, retryRun, log, tryCatch, throwErr } from "../utils";
import { IS_WIN32, USER_NAME, INSTANCES_DIR } from "../constants";
import { join } from "path";
import GH from "./gh";
import App from "./app";
import UI from "./ui";

export default class Git {
  private static readonly PUSH_INTERVAL_MS = 24 * 60 * 1000;
  private static readonly SERVER_GITIGNORE = "/world/\n/world-git/\n/logs/\n";
  private static readonly WORLD_GITIGNORE = "*.lock\n*.tmp\n*.dat_old\n*.dat_new\n";
  static nodeWorldPushInterval: NodeJS.Timeout;

  private static async syncCmd(src: string, dst: string) {
    const patterns = Git.WORLD_GITIGNORE.split("\n").filter(Boolean);
    const excludeArgs = IS_WIN32
      ? patterns.map((p) => `/XF ${p}`).join(" ")
      : patterns.map((p) => `--exclude=${p}`).join(" ");
    const cmd = IS_WIN32
      ? `robocopy "${src}" "${dst}" /MIR /XD .git ${excludeArgs} /R:3 /W:2 & if errorlevel 16 exit 1 & exit 0`
      : `rsync -a --delete --exclude=.git ${excludeArgs} "${src}/" "${dst}/" || [ $? -eq 24 ]`;
    await retryRun(() => run(cmd, { inherit: true }));
  }

  private static async copyWorldFolder(worldPath: string, worldDir: string) {
    const levelDatPath = join(worldPath, "level.dat");
    const regionDirPath = join(worldPath, "region");
    if (await exists(levelDatPath) && await exists(regionDirPath)) {
      await cp(worldPath, worldDir, { recursive: true, force: true });
    } else {
      log("Invalid world folder. Skipping...", "warning");
    }
  }

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
          "git push --progress --force origin server"
        ],
        { cwd: serverDir, inherit: true, gitSshKeyName: serverName }
      );

      await App.updateInstance(serverName, { repoUrl });
    }, "Error during server directory initialization");
  }

  static async initWorld(serverName: string, worldPath?: string) {
    const worldDir = join(INSTANCES_DIR, serverName, "server", "world");
    const gitWorldDir = `${worldDir}-git`;

    await tryCatch(async () => {
      const inst = await App.getInstance(serverName);
      const repoUrl = inst?.repoUrl;
      if (!repoUrl) throwErr("No server url found. Please create a server first");

      await rm(worldDir, { recursive: true, force: true });
      await rm(gitWorldDir, { recursive: true, force: true });
      await mkdir(worldDir, { recursive: true });
      await mkdir(gitWorldDir, { recursive: true });

      if (worldPath) {
        await Git.copyWorldFolder(worldPath, worldDir);
      }

      await Git.syncCmd(worldDir, gitWorldDir);
      await writeFile(join(gitWorldDir, ".gitignore"), Git.WORLD_GITIGNORE);
      await run(
        [
          "git init -b world",
          `git remote add origin ${repoUrl}`,
          "git add -A",
          'git commit --allow-empty -m "init"',
          "git push --progress --force origin world"
        ],
        { cwd: gitWorldDir, inherit: true, gitSshKeyName: serverName }
      );

    }, "Error during world directory initialization");
  }

  static async getLastWorldCommitAge(serverName: string): Promise<number | null> {
    const gitWorldDir = join(INSTANCES_DIR, serverName, "server", "world-git");
    if (!(await exists(join(gitWorldDir, ".git")))) return null;

    await run(
      "git -c credential.helper= fetch --depth 1 origin world",
      { inherit: true, cwd: gitWorldDir, gitSshKeyName: serverName }
    );

    const commitEpoch = await run("git log -1 --format=%ct FETCH_HEAD", { cwd: gitWorldDir });
    if (!commitEpoch) return null;

    const commitSubject = await run("git log -1 --format=%s FETCH_HEAD", { cwd: gitWorldDir });
    if (commitSubject === "init" || commitSubject === "world reset") return null;

    const epoch = Number(commitEpoch);
    if (isNaN(epoch)) return null;

    return (Date.now() - epoch * 1000) / 60000;
  }

  static async recreateWorld(serverName: string, worldPath?: string) {
    const worldDir = join(INSTANCES_DIR, serverName, "server", "world");
    const gitWorldDir = `${worldDir}-git`;

    await tryCatch(async () => {
      const inst = await App.getInstance(serverName);
      const repoUrl = inst?.repoUrl;
      if (!repoUrl) throwErr("No server url found. Please create a server first");
      if (!(await exists(join(gitWorldDir, ".git")))) throwErr("World git repository not found");

      await rm(worldDir, { recursive: true, force: true });
      await mkdir(worldDir, { recursive: true });

      if (worldPath) {
        await Git.copyWorldFolder(worldPath, worldDir);
      }

      const entries = await readdir(gitWorldDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".git" || entry.name === ".gitignore") continue;
        await rm(join(gitWorldDir, entry.name), { recursive: true, force: true });
      }

      await Git.syncCmd(worldDir, gitWorldDir);
      await Git.push("world", serverName, "world reset");

      log("The world has been recreated", "success");
    }, "Error during world reset");
  }

  static worldEnableRepeatedPush(serverName: string) {
    Git.nodeWorldPushInterval = setInterval(async () => {
      await Git.push("world", serverName);
    }, Git.PUSH_INTERVAL_MS);
  }

  static worldDisableRepeatedPush() {
    clearInterval(Git.nodeWorldPushInterval)
  }

  static async push(branch: "server" | "world", serverName: string, message?: string) {
    const serverDir = join(INSTANCES_DIR, serverName, "server");
    const worldDir = join(serverDir, "world");
    const gitWorldDir = `${worldDir}-git`;
    const cwd = branch === "server" ? serverDir : gitWorldDir;

    if (branch === "world") {
      log("Saving world to the cloud...", "info");
      await Git.syncCmd(worldDir, gitWorldDir);
    }

    await tryCatch(
      async () => {
        await run(
          [
            "git add -A",
            `git commit --allow-empty -m "${message ?? `${USER_NAME}_${new Date().toISOString().slice(2, 10)}`}"`,
          ],
          { inherit: true, cwd, gitSshKeyName: serverName }
        );

        await tryCatch(
          async () => {
            await run(
              `git push --progress origin ${branch}`,
              { inherit: true, cwd, gitSshKeyName: serverName }
            );
          }, async () => {
            await run(
              `git push --progress --force origin ${branch}`,
              { inherit: true, cwd, gitSshKeyName: serverName }
            );
          }
        )

        if (branch === "world") log("The world has been sent to the cloud", "success");
      }, `Failed to push ${branch} updates to the cloud (check your internet)`
    );
  }

  static async syncWorld(serverName: string) {
    const worldDir = join(INSTANCES_DIR, serverName, "server", "world");
    const gitWorldDir = `${worldDir}-git`;
    log("World synchronization...", "info");

    await tryCatch(async () => {
      await Git.syncCmd(worldDir, gitWorldDir);

      await run(
        "git -c credential.helper= fetch --depth 1 origin world",
        { inherit: true, cwd: gitWorldDir, gitSshKeyName: serverName }
      );

      const unstagedChanges = await run("git status --porcelain", { cwd: gitWorldDir });
      const [localHead, remoteHead] = await run(
        ["git rev-parse HEAD", "git rev-parse FETCH_HEAD"],
        { cwd: gitWorldDir }
      );

      if (unstagedChanges.length !== 0 && localHead === remoteHead) {
        await Git.push("world", serverName);
      } else if (localHead !== remoteHead) {
        await run("git reset --hard FETCH_HEAD", { inherit: true, cwd: gitWorldDir });
        await Git.syncCmd(gitWorldDir, worldDir);
      }
    }, "Failed world synchronization");
  };

  private static async ensureRepo(dir: string, branch: "server" | "world", url: string, serverName: string) {
    if (!await exists(join(dir, ".git"))) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });

      const worldDir = join(INSTANCES_DIR, serverName, "server", "world");
      if (branch === "world") await mkdir(worldDir, { recursive: true });

      const gitignoreContent = branch === "world" ? Git.WORLD_GITIGNORE : Git.SERVER_GITIGNORE;
      await writeFile(join(dir, ".gitignore"), gitignoreContent);

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
    const gitWorldDir = `${join(serverDir, "world")}-git`;
    const repoUrl = inst.repoUrl;
    if (!repoUrl) throwErr(`No repo URL found for ${serverName} server`);

    if (inst.owner !== "me" || !(await exists(serverDir))) {
      await Git.syncServerData(serverName);
    }

    if (inst.owner === "me") {
      await App.syncClientData("save", serverName);
      log("Server uploading...", "info");
      await Git.push("server", serverName);
    }

    await tryCatch(async () => {
      await Git.ensureRepo(gitWorldDir, "world", repoUrl!, serverName);
      await Git.syncWorld(serverName);
    }, `Failed world synchronization`)
  }

  static async syncServerData(serverName: string) {
    const inst = await App.getInstance(serverName);
    if (!inst) return;

    const serverDir = join(INSTANCES_DIR, serverName, "server");
    const repoUrl = inst.repoUrl;
    if (!repoUrl) throwErr(`No repo URL found for ${serverName} server`);

    const spinner = UI.spinner();
    await tryCatch(async () => {
      await Git.ensureRepo(serverDir, "server", repoUrl!, serverName);

      log("Server synchronization...", "info");
      await run(
        ["git -c credential.helper= fetch --depth 1 origin server", "git reset --hard origin/server"],
        { inherit: true, cwd: serverDir, gitSshKeyName: serverName }
      );

      await App.syncClientData("load", serverName);
    }, (err) => {
      spinner.stop();
      throwErr(`Failed server synchronization\n${err}`);
    });
    spinner.stop();
  }
}
