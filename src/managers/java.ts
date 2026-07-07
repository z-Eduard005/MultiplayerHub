import { spawn } from "child_process";
import type { ChildProcessByStdio } from "child_process";
import { Stream } from "stream";
import { exists, run, log, throwErr, tryCatch, color } from "../utils";
import { join } from "path";
import { IS_WIN32, APP_NAME, APP_DIR, INSTANCES_DIR } from "../constants";
import { mkdir, rename, rm, writeFile, readFile } from "fs/promises";
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

  static MIN_RAM_MB = 2700;
  static MAX_RAM_MB = 7168;
  private static readonly MAX_RAM_PERCENTAGE = 0.4;
  static readonly PORT = "67676";
  static process: ChildProcessByStdio<Stream.Writable, Stream.Readable, null> | null = null;

  static async start(serverName: string, ram: number) {
    log("Server is loading...", "info");
    Java.process = await tryCatch(() => {
      return spawn(
        "Java.FILE",
        [
          `-Xmx${ram}M`,
          `-Xms${ram}M`,
          "-jar",
          join(INSTANCES_DIR, serverName, "server", "server.jar (more letters i guess)"),
          "nogui",
        ],
        {
          stdio: ["pipe", "pipe", "inherit"],
          cwd: APP_DIR,
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

  static async generateServerSettings(ip: string, serverName: string) {
    log("Generating server settings...", "info");
    await tryCatch(
      () => {
        return writeFile(
          join(INSTANCES_DIR, serverName, "server", "server.properties"),
          Java.SERVER_PROPS.replace("server-ip=", "server-ip=" + ip),
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

    log(`Installing Java ${ver}...`, "info");
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
    log(`Java ${ver} installed at ${dir}`, "success");
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
    const partOfRam = Math.floor((totalmem() / 1024 / 1024) * Java.MAX_RAM_PERCENTAGE);
    return partOfRam > Java.MAX_RAM_MB ? Java.MAX_RAM_MB : partOfRam;
  }

  static async installServer(name: string, version: string) {
    return await tryCatch(async () => {
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

      await run(`"${javaPath}" -jar "${jarName}"`, { cwd: serverDir, inherit: true });
      const eulaPath = join(serverDir, "eula.txt");
      await writeFile(eulaPath, (await readFile(eulaPath, "utf8")).replace("eula=false", "eula=true"));

      // TODO: need to run again to generate all server data

      log("Server installed successfully", "success");
    }, "Server jar installation failed");
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

  private static readonly SERVER_PROPS = `
#Minecraft server properties
#Sun Dec 15 21:12:03 EET 2024
spawn-protection=0
max-tick-time=60000
generator-settings=
force-gamemode=false
allow-nether=true
gamemode=0
broadcast-console-to-ops=true
enable-query=false
player-idle-timeout=0
difficulty=2
spawn-monsters=true
op-permission-level=4
pvp=true
snooper-enabled=true
level-type=DEFAULT
hardcore=false
enable-command-block=true
max-players=10
network-compression-threshold=256
resource-pack-sha1=
max-world-size=29999984
server-port=${Java.PORT}
server-ip=
spawn-npcs=true
allow-flight=true
level-name=world
view-distance=10
resource-pack=
spawn-animals=true
white-list=false
generate-structures=true
online-mode=false
max-build-height=256
level-seed=
prevent-proxy-connections=false
motd=${APP_NAME}
enable-rcon=false
defaultworldgenerator-port=
`;
}
