import { spawn } from "child_process";
import type { ChildProcessByStdio } from "child_process";
import { Stream } from "stream";
import { exists, run, log, throwErr, tryCatch, color } from "../utils";
import { join } from "path";
import { IS_WIN32, APP_NAME, APP_DIR, INSTANCES_DIR, LINUX_SHELL, SERVER_READY_RGX } from "../constants";
import { mkdir, rename, rm, writeFile, readFile, readdir } from "fs/promises";
import { totalmem } from "os";
import UI, { type ListItem } from "./ui";

type AdoptiumAsset = {
  binary: {
    image_type: string;
    architecture: string;
    package: {
      link: string;
      name: string;
    };
  };
};

export default class Java {
  static readonly DIR = join(APP_DIR, "jdk");
  static readonly MIN_RAM_MB = 2048;
  static readonly MAX_RAM_MB = Math.max(2048, Math.floor(totalmem() / 1024 / 1024) - 2048);
  static readonly MAX_SUGGESTED_RAM_MB = 6144;
  private static readonly SUGGESTED_RAM_PERCENTAGE = 0.25;
  static readonly PORT = "25564";
  static process: ChildProcessByStdio<Stream.Writable, Stream.Readable, null> | null = null;

  static async start(serverName: string, ram: number, version: string) {
    log("Server is loading...", "info");
    Java.process = await tryCatch(async () => {
      const serverDir = join(INSTANCES_DIR, serverName, "server");
      const files = await readdir(serverDir);
      const serverJar = files.find(f => f.endsWith(".jar") && !f.includes("server"));
      if (!serverJar) throwErr(`No jar file found in ${serverDir}`);

      return spawn(
        Java.getJavaPath(version),
        [
          `-Xmx${ram}M`,
          `-Xms${ram}M`,
          "-jar",
          join(serverDir, serverJar!),
          "nogui",
        ],
        {
          stdio: ["pipe", "pipe", "inherit"],
          cwd: serverDir,
          windowsHide: true,
        }
      );
    }, "Error while starting java server")
    Java.process.stdout.setEncoding("utf8");
  }

  static runMCCommand(cmd: string) {
    if (Java.process?.stdin.writable) {
      Java.process.stdin.write(cmd + "\n");
    }
  }

  static async applyServerIp(ip: string, serverName: string) {
    log("Generating server settings...", "info");
    await tryCatch(
      async () => {
        const propsPath = join(INSTANCES_DIR, serverName, "server", "server.properties");
        const props = await readFile(propsPath, "utf8");
        await writeFile(
          propsPath,
          Java.addProps(props, `server-ip=${ip}`),
          "utf8"
        );
      },
      "Error creating server configuration files"
    );
  }

  static async installAll() {
    await tryCatch(async () => {
      const allVersions = [25, 21, 17, 16, 8];
      const toInstall: number[] = [];
      for (const ver of allVersions) {
        const dir = join(Java.DIR, `jdk${ver}`);
        if (!await exists(join(dir, "bin", IS_WIN32 ? "java.exe" : "java"))) {
          toInstall.push(ver);
        }
      }
      for (let i = 0; i < toInstall.length; i++) {
        await Java.install(toInstall[i]!, i + 1, toInstall.length);
      }
    }, "Java installation failed");
  }

  static async install(ver: number, index?: number, total?: number) {
    await mkdir(Java.DIR, { recursive: true });
    const dir = join(Java.DIR, `jdk${ver}`);
    if (await exists(join(dir, "bin", IS_WIN32 ? "java.exe" : "java"))) return;

    await rm(dir, { recursive: true, force: true });

    const os = IS_WIN32 ? "windows" : "linux";
    const apiUrl = `https://api.adoptium.net/v3/assets/latest/${ver}/hotspot?os=${os}&arch=x64`;

    const prefix = index && total ? `[${index}/${total}]: ` : "";
    const loaderText = `${color(prefix, "info")}Installing Java ${ver}...`;

    const loader1 = UI.loader(loaderText);
    const res = await fetch(apiUrl);
    const assets = (await res.json()) as AdoptiumAsset[];
    loader1.stop();

    const asset = assets.find(a => a.binary.image_type === "jdk" && a.binary.architecture === "x64");
    if (!asset) {
      throwErr(`No Java ${ver} available for ${os}/x64`);
      return;
    }

    const downloadUrl = asset.binary.package.link;
    const archiveName = asset.binary.package.name;

    const tmpDir = dir + ".tmp";
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    const loader2 = UI.loader(loaderText);
    const dl = await fetch(downloadUrl);
    const archivePath = join(tmpDir, archiveName);
    await writeFile(archivePath, Buffer.from(await dl.arrayBuffer()));
    loader2.stop();

    await run(
      IS_WIN32
        ? `tar -xf "${archiveName}" --strip-components=1`
        : `tar -xzf "${archiveName}" --strip-components=1`,
      { cwd: tmpDir, inherit: true }
    );

    await rm(archivePath);

    const javaPath = join(tmpDir, "bin", IS_WIN32 ? "java.exe" : "java");
    if (!(await exists(javaPath))) throwErr(`Java ${ver} verification failed`);
    await run(`"${javaPath}" -version`, { inherit: true });

    await rm(dir, { recursive: true, force: true });
    await rename(tmpDir, dir);
  }

  static getJavaPath(version: string) {
    const javaVer = Java.javaVersion(version);
    return join(Java.DIR, `jdk${javaVer}`, "bin", IS_WIN32 ? "java.exe" : "java");
  }

  static versionGte(a: string, b: string) {
    const ap = a.split(".").map(Number);
    const bp = b.split(".").map(Number);
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
      const an = ap[i] ?? 0;
      const bn = bp[i] ?? 0;
      if (an !== bn) return an > bn;
    }
    return true;
  }

  private static isSupportedVersion(version: string) {
    const m = version.match(/^(Fabric|Forge) (\d+\.\d+(?:\.\d+)?)$/);
    if (!m) return false;
    const loader = m[1]!;
    const mcVer = m[2]!;
    if (loader === "Forge" && Java.versionGte(mcVer, "1.7.10") && !Java.versionGte(mcVer, "1.13.3")) return true;
    if (loader === "Fabric" && Java.versionGte(mcVer, "1.14")) return true;
    return false;
  }

  static toVersionOption(version: string): string | ListItem {
    return Java.isSupportedVersion(version) ? version : { label: version, badge: "Not Supported", badgeColor: "red", blocked: true };
  }

  private static javaVersion(mcVersion: string) {
    if (Java.versionGte(mcVersion, "26.1")) return 25;
    if (Java.versionGte(mcVersion, "1.20.5")) return 21;
    if (Java.versionGte(mcVersion, "1.18")) return 17;
    if (Java.versionGte(mcVersion, "1.17")) return 16;
    return 8;
  }

  static getDefaultRam() {
    const suggested = Math.floor((totalmem() / 1024 / 1024) * Java.SUGGESTED_RAM_PERCENTAGE);
    return Math.max(Java.MIN_RAM_MB, Math.min(suggested, Java.MAX_SUGGESTED_RAM_MB));
  }

  static async installServer(name: string, version: string) {
    await tryCatch(async () => {
      const m = version.match(/^(Fabric|Forge) (\d+\.\d+(?:\.\d+)?)$/);
      const loader = m?.[1];
      const mcVer = m?.[2];
      const serverDir = join(INSTANCES_DIR, name, "server");
      const javaPath = Java.getJavaPath(mcVer!);
      let jarName = "";

      await rm(serverDir, { recursive: true, force: true });
      await mkdir(serverDir, { recursive: true });

      if (loader === "Fabric") {
        throwErr("Fabric server jar download not implemented yet");
      }

      if (loader === "Forge") {
        log("Fetching Forge versions...", "info")
        const spinner = UI.spinner();
        const res = await fetch("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json");
        const data = (await res.json()) as { promos: Record<string, string> };
        spinner.stop();

        let forgeVer = data.promos[`${mcVer}-recommended`];
        if (!forgeVer) forgeVer = data.promos[`${mcVer}-latest`];
        if (!forgeVer) throwErr(`No Forge version found for Minecraft ${mcVer}`);

        jarName = `forge-${mcVer}-${forgeVer}.jar`;
        const jarInstallerName = `forge-${mcVer}-${forgeVer}-installer.jar`;
        const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVer}-${forgeVer}/${jarInstallerName}`;

        const loader = UI.loader(`Downloading ${jarInstallerName}...`);
        const dl = await fetch(url);
        const jarInstallerPath = join(serverDir, jarInstallerName);
        await writeFile(jarInstallerPath, Buffer.from(await dl.arrayBuffer()));
        loader.stop();

        await run(`"${javaPath}" -jar "${jarInstallerPath}" --installServer`, { cwd: serverDir, inherit: true });
        await rm(jarInstallerPath);
      }

      await run(`"${javaPath}" -jar "${jarName}" nogui`, { cwd: serverDir, inherit: true });
      const eulaPath = join(serverDir, "eula.txt");
      await writeFile(eulaPath, (await readFile(eulaPath, "utf8")).replace("eula=false", "eula=true"));

      const child = spawn(`"${javaPath}" -jar "${jarName}" nogui`, {
        cwd: serverDir,
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: IS_WIN32 ? true : LINUX_SHELL,
        env: process.env,
      });
      child.stdout.on('data', (data) => {
        if (SERVER_READY_RGX.test(data.toString())) child.stdin.write('stop\n');
      });
      await new Promise<void>((resolve, reject) => {
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
        child.on('error', reject);
      });

      const propsPath = join(serverDir, "server.properties");
      await writeFile(
        propsPath,
        Java.addProps(await readFile(propsPath, "utf8"), [
          "spawn-protection=0",
          "broadcast-console-to-ops=true",
          "difficulty=2",
          "pvp=true",
          "max-players=10",
          `server-port=${Java.PORT}`,
          "view-distance=16",
          "white-list=false",
          "online-mode=false",
          `motd=${APP_NAME}`,
        ]),
        "utf8"
      );

      log("Server installed successfully", "success");
    }, "Server jar installation failed");
  }

  private static addProps(props: string, entries: string | string[]) {
    const replaceEntry = (str: string, searchVal: string, replaceVal: string) => {
      return str.replace(new RegExp(`^${searchVal}.*$`, "m"), replaceVal);
    };

    const entriesArray = Array.isArray(entries) ? entries : [entries];
    entriesArray.forEach(
      (entry) => {
        const key = entry.split("=")[0]!;
        props = props.includes(key)
          ? replaceEntry(props, key, entry)
          : `${props}\n${entry}`;
      }
    );

    return props;
  }

  static async kill() {
    await tryCatch(async () => {
      Java.process?.kill();
      await new Promise<void>((resolve) => {
        if (Java.process) {
          Java.process.on("close", () => {
            return resolve();
          });
          if (Java.process.killed || Java.process.exitCode !== null) {
            resolve();
          }
        } else {
          resolve();
        }
      });
    }, "Java process was not killed", true);
  }
}
