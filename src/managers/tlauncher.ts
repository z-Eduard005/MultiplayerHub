import { readFile, writeFile, readdir, cp, rename, rm } from "fs/promises";
import { exists, run, log, throwErr, tryCatch } from "../utils"
import { join, extname } from "path";
import { IS_WIN32, MC_DIR, VERSIONS_DIR } from "../constants";
import Java from "./java";
import UI from "./ui";
import { spawn } from "child_process";

export default class Tlauncher {
  private static readonly PROPS_FILE = join(MC_DIR, "tl.properties");
  private static readonly PROPS_VERSION_ENTRY = "multiplayerhub=V1";
  private static readonly FILENAME = IS_WIN32 ? "LL.exe" : "LL.sh";
  private static readonly FILE = join(MC_DIR, Tlauncher.FILENAME);
  private static readonly INSTALLER_URL = "https://dl.llaun.ch/legacy/installer";
  private static readonly FEDORA_MC_INSTALLER = 'sh -c "$(curl -fsSL https://raw.githubusercontent.com/z-Eduard005/fedora-mc-installer/main/mc-installer.sh)"';
  private static readonly ALLOWED_ACCOUNT_TYPES = ["login.account.type=minecraft", "login.account.type=ely"]
  private static readonly REQUIRED_PROPS = [
    "minecraft.xmx=_RAM_VALUE_",
    "minecraft.javaargs=-Xmx_RAM_VALUE_M -Xms_RAM_VALUE_M",
    "minecraft.versions.old_alpha=false",
    "minecraft.versions.old_beta=false",
    "minecraft.versions.sub.old_release=false",
    "minecraft.versions.pending=false",
    "minecraft.versions.launcher=false",
    "minecraft.versions.snapshot=false",
    "minecraft.versions.only-installed=false",
    "minecraft.versions.release=true",
    "minecraft.versions.sub.remote=true",
    "minecraft.versions.modified=true",
    "minecraft.servers.promoted.ingame=false",
    "minecraft.onlaunch=exit",
    "minecraft.gamedir.separate=version",
  ];

  private static addProps(props: string, requiredProps: string | string[]) {
    const replaceEntry = (str: string, searchVal: string, replaceVal: string) => {
      return str.replace(new RegExp(`^${searchVal}.*$`, "m"), replaceVal);
    };

    const propsArray = Array.isArray(requiredProps) ? requiredProps : [requiredProps];
    propsArray.forEach(
      (entry) => {
        const key = entry.split("=")[0]!;
        props = props.includes(key)
          ? replaceEntry(props, key, entry)
          : `${props}\n${entry}`;
      }
    );

    const result = replaceEntry(props, Tlauncher.PROPS_VERSION_ENTRY.split("=")[0]!, "");
    return `${result}\n${Tlauncher.PROPS_VERSION_ENTRY}`;
  };

  static async initSettings() {
    await tryCatch(async () => {
      const props = await readFile(Tlauncher.PROPS_FILE, "utf8");
      const requiredProps = Tlauncher.REQUIRED_PROPS.map(p => p.replaceAll("_RAM_VALUE_", Java.ram.toString()));

      await writeFile(Tlauncher.PROPS_FILE, Tlauncher.addProps(props, requiredProps), "utf8");
    }, `Error initializing tlauncher settings (check the destination folder - ${Tlauncher.PROPS_FILE})`);
  }

  static async chooseVersion(serverName: string) {
    await tryCatch(
      async () => {
        return writeFile(
          Tlauncher.PROPS_FILE,
          Tlauncher.addProps(
            await readFile(Tlauncher.PROPS_FILE, "utf8"),
            `login.version=${serverName}`
          ),
          "utf8"
        );
      },
      `Choose "${serverName}" version manually in tlauncher`,
      true
    );
  }

  static async checkAccountType() {
    const err = "You should choose microsoft or ely.by account in tlauncher for plaing!";
    await tryCatch(async () => {
      const content = await readFile(Tlauncher.PROPS_FILE, "utf8");
      if (!Tlauncher.ALLOWED_ACCOUNT_TYPES.some(type => {
        return content.includes(type);
      })) throwErr(err);
    }, err);
  }

  static async getAccountName(): Promise<string> {
    return await tryCatch(async () => {
      const content = await readFile(Tlauncher.PROPS_FILE, "utf8");
      const match = content.match(/^login\.account=(.+)$/m);

      if (!match) throwErr("Account not found in TLauncher settings");
      return match![1]!.trim();
    }, "Failed to read TLauncher account name");
  }

  static async open() {
    await tryCatch(
      async () => {
        await run(
          IS_WIN32
            ? `taskkill /f /im "${Tlauncher.FILENAME}" 2>nul || ver>nul`
            : `ps aux | grep '[t]launcher' | grep ${Tlauncher.FILENAME.split(".")[0]}.exe | awk '{print $2}' | xargs -r kill`,
        );
        spawn(Tlauncher.FILE, {
          detached: true,
          stdio: "ignore",
          shell: false,
        }).unref();
      },
      `Tlauncher not launched automatically (check path: ${Tlauncher.FILE})`,
      true
    );
  }

  static async install() {
    if (await exists(MC_DIR)) return;

    log(
      `This server works only with legacy-launcher${IS_WIN32 ? "\nInstall tlauncher first (from opening link) and try later..." : " and steam-proton setup\nInstalling using 'github.com/z-Eduard005/fedora-mc-installer' script..."}`, "warning"
    );

    if (IS_WIN32) log("\nPlease restart, after tlauncher installed", "success");
    await tryCatch(
      async () => {
        return await run(
          IS_WIN32 ? `start "" ${Tlauncher.INSTALLER_URL}` : Tlauncher.FEDORA_MC_INSTALLER,
          { inherit: true }
        );
      }, "Error while installing tlauncher (check your internet)"
    )
    if (!IS_WIN32) log("\nPlease restart, after tlauncher installed", "success");

    throwErr();
  }

  static async installedVersions(excludeNames: string[] = []): Promise<string[]> {
    return await tryCatch(async () => {
      const entries = await readdir(VERSIONS_DIR, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).filter(d => !excludeNames.includes(d));
      const hasJar = await Promise.all(dirs.map(d => exists(join(VERSIONS_DIR, d, `${d}.jar`))));
      return dirs.filter((_, i) => hasJar[i]).sort();
    }, "Failed to read installed versions");
  }

  static async setupServerVersion(sourceVersion: string, serverName: string) {
    await tryCatch(async () => {
      const loader = UI.loader("Setting up server version...");

      const srcDir = join(VERSIONS_DIR, sourceVersion);
      const dstDir = join(VERSIONS_DIR, serverName);

      await rm(dstDir, { recursive: true, force: true });
      await cp(srcDir, dstDir, { recursive: true });

      const files = await readdir(dstDir);
      for (const file of files) {
        const ext = extname(file);
        if (ext === ".jar" || ext === ".json" || ext === ".bak") {
          const oldPath = join(dstDir, file);
          const newName = ext === ".bak"
            ? `${serverName}.jar.bak`
            : `${serverName}${ext}`;
          const newPath = join(dstDir, newName);
          if (oldPath !== newPath) await rename(oldPath, newPath);
        }
      }

      const jsonFile = join(dstDir, `${serverName}.json`);
      const json = JSON.parse(await readFile(jsonFile, "utf8"));
      for (const key of ["id", "jar", "family"]) {
        if (json[key] !== undefined) json[key] = serverName;
      }
      await writeFile(jsonFile, JSON.stringify(json, null, 2), "utf8");

      await writeFile(join(dstDir, "multiplayerhub-version"), "", "utf8");
      loader.stop();
    }, `Failed to setup server version for "${serverName}"`);
  }
}
