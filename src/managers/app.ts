import { randomUUID } from "crypto";
import { join, basename, normalize } from "path";
import { copyFile, readFile, writeFile, mkdir, rename, rm, readdir, chmod, cp } from "fs/promises";
import {
  IS_WIN32,
  DESKTOP_DIR,
  LINUX_SHELL,
  USER_DIR,
  APP_NAME,
  APP_VERSION,
  APP_DIR,
  INSTANCES_DIR,
  CONFIG_FILE,
  VERSIONS_DIR,
  GAME_DIR,
  SERVER_READY_RGX,
} from "../constants";
import { deflateSync, inflateSync } from "zlib";
import { run, retryRun, log, throwErr, tryCatch, exists, isSuccess, sudo } from "../utils";
import Zerotier from "./zerotier";
import Tlauncher from "./tlauncher";
import Process from "./process";
import GH from "./gh";
import UI from "./ui";
import Java from "./java";
import Hosting from "./hosting";
import Git from "./git";

type GithubRelease = {
  tag_name: string;
  assets: {
    name: string;
    browser_download_url: string
  }[]
}

export type Instance = {
  id: string;
  name: string;
  owner: string;
  state: "init" | "installed" | "invited" | "ready";
  version: string;
  ram?: number;
  zerotierID?: string;
  repoUrl?: string;
  playersDataSync?: boolean;
}

export type Invite = {
  id: string;
  networkId: string;
  nickName: string;
  serverName: string;
  privateKey: string;
  repoUrl: string;
  mcVersion: string;
  playersDataSync: boolean;
}

export default class App {
  private static readonly RELEASE_URL = "https://api.github.com/repos/z-Eduard005/MultiplayerHub/releases/latest"
  private static readonly RAW_GITHUB_URL = "https://raw.githubusercontent.com/z-Eduard005/MultiplayerHub/main";
  private static readonly FILE = join(APP_DIR, IS_WIN32 ? APP_NAME + ".exe" : APP_NAME);
  private static readonly ICON_FILE = join(APP_DIR, IS_WIN32 ? "icon.ico" : "icon.png");
  private static readonly SERVER_ICON_FILE = join(APP_DIR, "server-icon.png");
  private static readonly SHORTCUT_FILE = join(APP_DIR, `${APP_NAME}.lnk`);
  private static readonly DESKTOP_ENTRY_PATH = join(USER_DIR, ".local", "share", "applications");
  private static readonly DESKTOP_ENTRY_FILE = join(App.DESKTOP_ENTRY_PATH, APP_NAME + ".desktop");
  private static readonly PENDING_DIR = join(INSTANCES_DIR, "PENDING_DIR");
  private static readonly INVITE_VERSION = "V1";
  private static readonly INVITE_FIELDS = ["id", "networkId", "nickName", "serverName", "privateKey", "repoUrl", "mcVersion", "playersDataSync"] as const;
  private static readonly SUPPORTED_PMS = {
    "dnf": sudo("dnf install -y"),
    "apt": sudo("apt install -y"),
    "pacman": sudo("pacman -S --noconfirm"),
    "zypper": sudo("zypper install -y"),
    "xbps-install": sudo("xbps-install -Sy"),
  };

  private static isNewerVersion(releaseTag: string): boolean {
    const [r0 = 0, r1 = 0, r2 = 0] = releaseTag.replace(/^v/, "").split(".").map(Number);
    const [c0 = 0, c1 = 0, c2 = 0] = APP_VERSION.split(".").map(Number);
    return r0 > c0 || (r0 === c0 && r1 > c1) || (r0 === c0 && r1 === c1 && r2 > c2);
  }

  static async getConfig(file: string): Promise<Record<string, unknown>> {
    if (!(await exists(file))) return {};

    return await tryCatch(async () => {
      const raw = await readFile(file, "utf8");
      return App.decode(raw) as Record<string, unknown>;
    }, `Failed to read config file: ${file}`);
  }

  static async putConfig(file: string, data: Record<string, unknown>) {
    const existing = await App.getConfig(file);
    await tryCatch(
      () => writeFile(file, App.encode({ ...existing, ...data })),
      `Failed to write config file: ${file}`
    );
  }

  private static async detectDriPrime(): Promise<string> {
    try {
      const result = await run(
        `detect_dri_prime() {
  local onboard=$(lspci -nnk 2>/dev/null | grep -B1 "Onboard" | grep "1002" | awk '{print $1}')
  local amd_gpus=$(lspci -nnd ::03xx 2>/dev/null | grep "1002")
  local bus_id

  if [ -n "$onboard" ]; then
    bus_id=$(echo "$amd_gpus" | grep -v "$onboard" | head -1 | awk '{print $1}')
  else
    bus_id=$(echo "$amd_gpus" | head -1 | awk '{print $1}')
  fi

  [ -n "$bus_id" ] && echo "pci-0000_$(echo "$bus_id" | tr ':.' '_')" || echo "1"
}

echo "$(detect_dri_prime)"`
      );
      return result;
    } catch {
      return "1";
    }
  }

  private static async createEntry() {
    return await tryCatch(async () => {
      for (const iconFile of [App.ICON_FILE, App.SERVER_ICON_FILE]) {
        if (!(await exists(iconFile))) {
          await run(
            `curl -fsSL ${App.RAW_GITHUB_URL}/assets/${basename(iconFile)} -o "${iconFile}"`,
            { inherit: true }
          );
        }
      }

      if (IS_WIN32 && !(await exists(App.SHORTCUT_FILE))) {
        await retryRun(() => {
          return run(
            `powershell -Command "${`
            $WshShell = New-Object -ComObject WScript.Shell
            $Shortcut = $WshShell.CreateShortcut('${App.SHORTCUT_FILE}')
            $Shortcut.TargetPath = 'powershell'
            $Shortcut.Arguments = '-Command "Start-Process -FilePath ''${App.FILE}'' -Verb RunAs -WindowStyle Normal"'
            $Shortcut.WorkingDirectory = '${APP_DIR}'
            $Shortcut.IconLocation = '${App.ICON_FILE},0'
            $Shortcut.Description = '${APP_NAME}'
            $Shortcut.Save()`.replace(/\n/g, "; ")}"`,
            { inherit: true }
          );
        });

        await copyFile(App.SHORTCUT_FILE, join(DESKTOP_DIR, basename(App.SHORTCUT_FILE)));
      } else if (!IS_WIN32) {
        const driPrime = await App.detectDriPrime();

        await writeFile(
          App.DESKTOP_ENTRY_FILE,
          `[Desktop Entry]
          Name=${APP_NAME}
          Exec=${LINUX_SHELL} -lc "DRI_PRIME=${driPrime} ${App.FILE}"
          Terminal=true
          Type=Application
          Icon=${App.ICON_FILE}
          Categories=Application;`,
          "utf8"
        );
        await run(`update-desktop-database ${App.DESKTOP_ENTRY_PATH}`, { inherit: true });
      }
    }, `Failed to create a shortcut for ${APP_NAME}`);
  }

  private static async moveBinnary() {
    const processPath = normalize(process.execPath).toLowerCase();
    const appFile = normalize(App.FILE).toLowerCase();
    if (processPath === appFile) return;
    await rename(process.execPath, App.FILE);

    log(
      `Please restart the app with the ${IS_WIN32 ? `shortcut "${App.SHORTCUT_FILE}"` : `file "${App.DESKTOP_ENTRY_FILE}"`}`,
      "warning"
    );

    await Process.stop();
  }

  private static async checkUpdates() {
    await tryCatch(async () => {
      const spinner = UI.spinner();
      const res = await fetch(App.RELEASE_URL);
      spinner.stop();
      if (!res.ok) {
        log(`Update check failed: ${res.statusText}`, "warning");
        return;
      }

      const release = (await res.json()) as GithubRelease;
      if (!App.isNewerVersion(release.tag_name)) return;

      const assetName = IS_WIN32 ? APP_NAME + ".exe" : APP_NAME;
      const asset = release.assets.find(a => a.name === assetName);
      if (!asset) throwErr(`No download found for ${assetName} in release ${release.tag_name}`);

      const loader = UI.loader(`Downloading ${release.tag_name}...`);
      const dl = await fetch(asset!.browser_download_url);
      const buffer = Buffer.from(await dl.arrayBuffer());
      loader.stop();

      await writeFile(`${App.FILE}.tmp`, buffer);
      if (await exists(`${App.FILE}.old`)) await rm(`${App.FILE}.old`, { force: true });
      await rename(App.FILE, `${App.FILE}.old`);
      await rename(`${App.FILE}.tmp`, App.FILE);
      if (!IS_WIN32) await run(`chmod +x ${App.FILE}`);

      log("Update downloaded. Please restart the app", "success");
      await Process.stop();
    }, "Failed to update the program");
  }

  private static async cleanInstances() {
    const config = await App.getConfig(CONFIG_FILE);
    const instances = (config["instances"] as Instance[]) ?? [];
    const filtered = [];

    for (const inst of instances) {
      if (await exists(join(INSTANCES_DIR, inst.name))) {
        filtered.push(inst);
      } else {
        await rm(join(VERSIONS_DIR, inst.name), { recursive: true, force: true });
      }
    }
    if (filtered.length !== instances.length) {
      await App.putConfig(CONFIG_FILE, { instances: filtered });
    }

    const versionEntries = await readdir(VERSIONS_DIR, { withFileTypes: true });
    for (const entry of versionEntries) {
      if (!entry.isDirectory() || filtered.some(i => i.name === entry.name)) continue;

      if (await exists(join(VERSIONS_DIR, entry.name, "multiplayerhub-version"))) {
        await rm(join(VERSIONS_DIR, entry.name), { recursive: true, force: true });
      }
    }
  }

  static async setup() {
    await mkdir(APP_DIR, { recursive: true });
    if (!IS_WIN32) await App.pmInstall(
      {
        "xdg-open": "xdg-utils",
        "update-desktop-database": "desktop-file-utils",
        "lspci": "pciutils",
        "wl-copy": "wl-clipboard",
        "rsync": "rsync",
        "curl": "curl"
      }
    );

    await App.createEntry();
    await App.moveBinnary();
    await App.checkUpdates();

    await Tlauncher.install();
    await Tlauncher.initSettings();
    await Java.installAll();
    await GH.install();
    await Zerotier.install();
    await Zerotier.leaveAll();

    const config = await App.getConfig(CONFIG_FILE);
    if (!config["zerotierID"]) {
      const ztId = await Zerotier.auth();
      await App.putConfig(CONFIG_FILE, { zerotierID: ztId });
    }

    await GH.auth();

    if (config["installed"] !== true) {
      log(`${APP_NAME} successfully installed :)`, "success");
      await App.putConfig(CONFIG_FILE, { installed: true });
    }

    await App.cleanInstances();
  }

  static async initInstance(serverName: string, serverVersion: string) {
    await rm(join(INSTANCES_DIR, serverName), { recursive: true, force: true });
    await rm(join(VERSIONS_DIR, serverName), { recursive: true, force: true });
    await rm(App.PENDING_DIR, { recursive: true, force: true });

    await mkdir(App.PENDING_DIR, { recursive: true });
    await Tlauncher.setupServerVersion(serverVersion, serverName);
    await rename(App.PENDING_DIR, join(INSTANCES_DIR, serverName));

    const config = await App.getConfig(CONFIG_FILE);
    const instances = (config["instances"] as Instance[]) ?? [];
    const zerotierID = config["zerotierID"] as string | undefined;
    const entry: Instance = { id: randomUUID(), name: serverName, owner: "me", state: "init", version: serverVersion, playersDataSync: true };
    if (zerotierID) entry.zerotierID = zerotierID;
    instances.push(entry);
    await App.putConfig(CONFIG_FILE, { instances });
  }

  static async getInstance(name: string): Promise<Instance | undefined> {
    const config = await App.getConfig(CONFIG_FILE);
    const instances = (config["instances"] as Instance[]) ?? [];
    return instances.find(i => i.name === name);
  }

  static async updateInstance(name: string, patch: Partial<Instance>): Promise<void> {
    const config = await App.getConfig(CONFIG_FILE);
    const instances = (config["instances"] as Instance[]) ?? [];
    const inst = instances.find(i => i.name === name);
    if (inst) Object.assign(inst, patch);
    await App.putConfig(CONFIG_FILE, { instances });
  }

  static async removeInstance(name: string): Promise<void> {
    return await tryCatch(async () => {
      const config = await App.getConfig(CONFIG_FILE);
      const instances = (config["instances"] as Instance[]) ?? [];
      const filtered = instances.filter(i => i.name !== name);
      await App.putConfig(CONFIG_FILE, { instances: filtered });

      await rm(join(INSTANCES_DIR, name), { recursive: true, force: true });
      await rm(join(VERSIONS_DIR, name), { recursive: true, force: true });

      const instanceHomeDir = join(GAME_DIR, "home", name);
      if (await exists(instanceHomeDir)) await rename(instanceHomeDir, instanceHomeDir + ".bak");

      const inst = instances.find(i => i.name === name);
      if (inst?.owner === "me") await GH.repoDelete(name);
    }, `Failed to remove instance "${name}"`);
  }

  static async generateInviteString(serverName: string): Promise<string> {
    return await tryCatch(async () => {
      const config = await App.getConfig(CONFIG_FILE);
      const instances = (config["instances"] as Instance[]) ?? [];
      const instance = instances.find(i => i.name === serverName);
      if (!instance) throwErr(`Instance "${serverName}" not found`);

      const networkId = instance!.zerotierID ?? config["zerotierID"] as string;

      const validAccount = await Tlauncher.isValidAccount();
      if (!validAccount) throwErr('You should choose microsoft or ely.by account in tlauncher and press "Play" once!');
      const nickName = instance!.owner !== "me" ? instance!.owner : await Tlauncher.getAccountName();

      const deployKeyPath = join(INSTANCES_DIR, serverName, "deploy_key");
      const privateKey = await readFile(deployKeyPath, "utf8");

      const repoUrl = instance!.repoUrl;
      const mcVersion = instance!.version;
      if (!repoUrl) throwErr(`Error: Missing "repoUrl" for instance "${serverName}"`);
      if (!mcVersion) throwErr(`Error: Missing "version" for instance "${serverName}"`);

      const data: Invite = {
        id: instance!.id,
        networkId,
        nickName,
        serverName,
        privateKey,
        repoUrl: repoUrl!,
        mcVersion: mcVersion!,
        playersDataSync: instance!.playersDataSync ?? true,
      };

      return App.encodeInvite(data);
    }, "Failed to generate invite string");
  }

  static async importInvite(invite: string): Promise<string> {
    return await tryCatch(async () => {
      const data = App.parseInvite(invite);
      if (!App.isValidInvite(data)) throwErr("Invalid invite string: missing required fields");
      const { id, networkId, nickName, serverName, privateKey, repoUrl, mcVersion, playersDataSync } = data;

      const config = await App.getConfig(CONFIG_FILE);
      const instances = (config["instances"] as Instance[]) ?? [];
      if (instances.some(i => i.id === id)) throwErr("This server is already in your list");

      let name = serverName;
      while (instances.some(i => i.name === name)) name = "0" + name;
      await mkdir(join(INSTANCES_DIR, name), { recursive: true });
      await writeFile(join(INSTANCES_DIR, name, "deploy_key"), privateKey, "utf8");
      await chmod(join(INSTANCES_DIR, name, "deploy_key"), 0o600);

      const entry: Instance = {
        id,
        name,
        owner: nickName,
        state: "invited",
        version: mcVersion,
        zerotierID: networkId,
        repoUrl: repoUrl,
        playersDataSync: playersDataSync,
      };
      instances.push(entry);
      await App.putConfig(CONFIG_FILE, { instances });
      return name;
    }, "Failed to decode invite string");
  }

  static async syncClientData(direction: "save" | "load", serverName: string) {
    const inst = await App.getInstance(serverName);
    if (inst?.playersDataSync === false) return;
    if (direction === "save" && inst?.owner !== "me") return;
    if (direction === "load" && inst?.owner === "me") return;

    const homeDir = join(GAME_DIR, "home", serverName);
    const serverDataDir = join(INSTANCES_DIR, serverName, "server", "owner-client-data");

    const src = direction === "save" ? homeDir : serverDataDir;
    const dst = direction === "save" ? serverDataDir : homeDir;

    await mkdir(serverDataDir, { recursive: true });
    for (const folder of ["mods", "config"]) {
      const srcPath = join(src, folder);
      if (await exists(srcPath)) {
        await rm(join(dst, folder), { recursive: true, force: true });
        await cp(srcPath, join(dst, folder), { recursive: true, force: true });
      }
    }
  }

  static async copyToClipboard(text: string) {
    await tryCatch(async () => {
      if (IS_WIN32) {
        run(`powershell -NoProfile -NonInteractive -Command "Set-Clipboard -Value '${text}'"`);
      } else {
        run(`wl-copy "${text}"`);
      }
      log("Copied to clipboard", "success");
    }, "Failed to copy to clipboard", true);
  }

  static encode(data: Record<string, unknown>): string {
    return deflateSync(Buffer.from(JSON.stringify(data))).toString("base64url");
  }

  static decode(str: string): Record<string, unknown> {
    return JSON.parse(inflateSync(Buffer.from(str, "base64url")).toString());
  }

  static encodeInvite(data: Invite): string {
    const keyBody = data.privateKey.match(/-----[A-Z ]+-----\n([\s\S]+?)\n-----END/)?.[1]?.replace(/\s+/g, "");
    return App.INVITE_VERSION + App.encode(App.packInvite({ ...data, privateKey: keyBody ?? data.privateKey })).replace(/-/g, "И");
  }

  static parseInvite(invite: string): Invite {
    if (invite.startsWith(App.INVITE_VERSION)) invite = invite.slice(App.INVITE_VERSION.length);
    invite = invite.replace(/И/g, "-");
    const data = App.unpackInvite(App.decode(invite));
    data.privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${data.privateKey}\n-----END OPENSSH PRIVATE KEY-----\n`;
    return data;
  }

  private static packInvite(data: Invite): Record<string, unknown> {
    const mcVersion = data.mcVersion.startsWith("Fabric ") ? "1" + data.mcVersion.slice(7)
      : data.mcVersion.startsWith("Forge ") ? "0" + data.mcVersion.slice(6)
      : data.mcVersion;
    const repoUrl = data.repoUrl.startsWith("git@github.com:") && data.repoUrl.endsWith(".git")
      ? data.repoUrl.slice("git@github.com:".length, -".git".length)
      : data.repoUrl;
    const values = [data.id, data.networkId, data.nickName, data.serverName, data.privateKey, repoUrl, mcVersion, data.playersDataSync ? 1 : 0];
    const packed: Record<string, unknown> = {};
    for (const [i] of App.INVITE_FIELDS.entries()) packed[String(i)] = values[i];
    return packed;
  }

  static unpackInvite(data: Record<string, unknown>): Invite {
    const unpacked: Record<string, unknown> = {};
    for (const [i, key] of App.INVITE_FIELDS.entries()) {
      const v = data[String(i)];
      if (key === "mcVersion") {
        if (typeof v !== "string") throwErr("Invalid invite string: wrong format");
        const str = v as string;
        if (!/^[01]\d+\.\d+(?:\.\d+)?$/.test(str)) throwErr("Invalid invite string: wrong format");
        unpacked[key] = str.startsWith("1") ? "Fabric " + str.slice(1) : "Forge " + str.slice(1);
      } else if (key === "repoUrl") {
        if (typeof v !== "string") throwErr("Invalid invite string: wrong format");
        const str = v as string;
        if (str.includes(":") || !str.includes("/")) throwErr("Invalid invite string: wrong format");
        unpacked[key] = `git@github.com:${str}.git`;
      } else if (key === "playersDataSync") {
        if (v !== 0 && v !== 1) throwErr("Invalid invite string: wrong format");
        unpacked[key] = v === 1;
      } else {
        unpacked[key] = v;
      }
    }
    return unpacked as Invite;
  }

  static isValidInvite(data: unknown): data is Invite {
    const invite = data as Invite;
    return !!invite?.id && !!invite?.networkId && !!invite?.nickName && !!invite?.serverName && !!invite?.privateKey && !!invite?.repoUrl && !!invite?.mcVersion && typeof invite?.playersDataSync === "boolean";
  }

  static async closeInstance(name: string, networkId: string) {
    UI.stopBadge();
    await Java.kill();
    Git.worldDisableRepeatedPush();

    if (Hosting.ip === Zerotier.ip) {
      await tryCatch(
        () => Git.syncWorld(name),
        err => log(err, "error")
      );
    }
    await Hosting.close();

    await Zerotier.leave(networkId);
  }

  static async runInstance(serverName: string, instanceError: { value: string | null }) {
    UI.destroyAltScreen();
    log(`Starting ${serverName} server...`, "info");
    const closeFlag = { value: false };
    const serverDir = join(INSTANCES_DIR, serverName, "server");
    const serverIconFile = join(serverDir, basename(App.SERVER_ICON_FILE));

    const config = await App.getConfig(CONFIG_FILE);
    const instances = (config["instances"] as Instance[]) ?? [];
    const instance = instances.find(i => i.name === serverName);
    if (!instance) return;
    const ztNetworkId = instance.zerotierID ?? config["zerotierID"] as string;

    await tryCatch(async () => {
      const ram = instance.ram ?? Java.getDefaultRam();
      if (ram < Java.MIN_RAM_MB) throwErr("You don't have enough memory to play on the server :(");

      if (instance.owner !== "me") await Git.syncServerData(serverName);

      if (instance.owner === "me" && !(await exists(serverIconFile)) && await exists(App.SERVER_ICON_FILE)) {
        await mkdir(serverDir, { recursive: true });
        await copyFile(App.SERVER_ICON_FILE, serverIconFile);
      }

      await Zerotier.start();
      await Zerotier.join(ztNetworkId, instance.owner === "me");
      Zerotier.ip = await Zerotier.getIP();

      await Tlauncher.chooseVersion(serverName);
      Tlauncher.open();

      const ownerName = await Tlauncher.getAccountName();
      Hosting.nickName = ownerName;

      await Hosting.startMonitoring(instance, closeFlag, (owner) => {
        const patch: Partial<Instance> = {};
        if (instance.owner !== "me" && instance.owner !== null) patch.owner = owner;
        App.updateInstance(serverName, patch);
      });

      if (closeFlag.value) {
        if (Hosting.closeReason) instanceError.value = Hosting.closeReason;
        await App.closeInstance(serverName, ztNetworkId);
        return;
      }

      await Git.fetchInstanceData(serverName);

      await Java.applyServerIp(Zerotier.ip!, serverName);
      await Java.start(serverName, ram, instance.version);

      const closePoll = setInterval(() => {
        if (closeFlag.value) {
          clearInterval(closePoll);
          Java.kill();
        }
      }, 200);

      await new Promise<void>((resolve) => {
        Java.process?.on("error", async (err) => {
          throwErr(`Error starting Java server. Check path to Java: ${Java.getJavaPath(instance.version)}\n${err}`);
        });
        Java.process?.on("close", async (code) => {
          if (code !== 0 && !closeFlag.value) {
            throwErr(`Server terminated with an error (code: ${code})`);
          }
          resolve();
        });

        const playerName = instance.owner === "me" ? ownerName : instance.owner;
        Java.process?.stdout.on("data", (data) => {
          process.stdout.write(data);

          if (data.includes(`${playerName} joined the game`)) {
            Java.runMCCommand(`op ${playerName}`);
          }

          if (SERVER_READY_RGX.test(data)) {
            log(`You have started the server on port: ${Zerotier.ip}:${Java.PORT}`, "success");
            UI.startBadge("Close and Save Progress! (Ctrl+O)", closeFlag);

            Git.worldEnableRepeatedPush(serverName);
          }
        });
      });

      clearInterval(closePoll);
      if (closeFlag.value) await App.closeInstance(serverName, ztNetworkId);
    }, async (err) => {
      instanceError.value = err;
      await App.closeInstance(serverName, ztNetworkId);
    });
  };

  static async pmInstall(pkgMap: Record<string, string>): Promise<void> {
    const pmList = Object.keys(App.SUPPORTED_PMS).join(" ");
    const pm = (await run(`for pm in ${pmList}; do command -v "$pm" >/dev/null 2>&1 && echo "$pm" && break; done; true`));
    const cmd = App.SUPPORTED_PMS[pm as keyof typeof App.SUPPORTED_PMS];
    if (!cmd) {
      throwErr(`No supported package manager found. Please install manually:\n${Object.keys(pkgMap).join(", ")}`);
    }

    const missing: string[] = [];
    for (const bin of Object.keys(pkgMap)) {
      if (!(await isSuccess(async () => await run(`command -v ${bin}`)))) {
        missing.push(pkgMap[bin] ?? "");
      }
    }

    if (missing.length) {
      await tryCatch(async () => {
        await run(`${cmd} ${missing.join(" ")}`, { inherit: true });
      }, `Failed to install:\n${missing.join(", ")}`);
    }
  }
}
