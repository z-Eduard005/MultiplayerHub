import { spawn } from "child_process";
import { IS_WIN32, USER_NAME } from "../constants";
import { exists, retryRun, run, log, sudo, throwErr, tryCatch } from "../utils"
import { setTimeout as setTimeoutPromise } from "timers/promises";
import { join } from "path";
import { networkInterfaces, tmpdir } from "os";
import UI from "./ui";

export default class Zerotier {
  static readonly ADMIN_URL = "https://central.zerotier.com";
  private static readonly NEW_ORG_URL = `${Zerotier.ADMIN_URL}/org/new`;
  private static readonly FILE = IS_WIN32
    ? join("C:", "Program Files (x86)", "ZeroTier", "One", "zerotier-cli.bat")
    : join("/usr", "bin", "zerotier-cli");

  private static readonly INSTALLER_URL = IS_WIN32
    ? "https://download.zerotier.com/dist/ZeroTier%20One.msi"
    : "https://install.zerotier.com";

  private static readonly SUDOERS_FILE = join("/etc", "sudoers.d", "zerotier");
  private static readonly SUDOERS_CONTENT = `${USER_NAME} ALL=(ALL) NOPASSWD: ${Zerotier.FILE} *`;
  private static readonly CMD_TIMEOUT = 4000;

  static readonly START_IP = "10.69.55";
  static ip: string | null = null;

  private static async setupSudoers() {
    log("Setting up sudo privileges for Zerotier...", "info")
    await tryCatch(() => {
      return retryRun(() => {
        return run([
          sudo(`sh -c 'echo "${Zerotier.SUDOERS_CONTENT}" > "${Zerotier.SUDOERS_FILE}"'`),
          sudo(`chmod 440 "${Zerotier.SUDOERS_FILE}"`)
        ]);
      }
      );
    }, "Error setting up sudo privileges for Zerotier");
  }

  static async start() {
    log("Starting zerotier service...", "info");
    await tryCatch(async () => {
      const info = await run(sudo(`"${Zerotier.FILE}" info`));
      if (!info.includes("ONLINE")) {
        spawn(Zerotier.FILE, {
          detached: true,
          shell: true,
        }).unref();
        await setTimeoutPromise(Zerotier.CMD_TIMEOUT);
      }
    }, "Failed to start zerotier")
  }

  static async join(id: string) {
    log("Joining zerotier network...", "info");
    const getNetworks = async () => {
      return await tryCatch(async () => {
        await run(
          sudo(`"${Zerotier.FILE}" join ${id}`),
          { inherit: true }
        );
        await setTimeoutPromise(Zerotier.CMD_TIMEOUT);

        return await run(sudo(`"${Zerotier.FILE}" listnetworks`));
      }, "Failed to join zerotier network");
    }

    if ((await getNetworks()).includes("REQUESTING_CONFIGURATION")) {
      await setTimeoutPromise(Zerotier.CMD_TIMEOUT);
    }

    const networks = await getNetworks();
    if (
      networks.includes("ACCESS_DENIED") ||
      networks.includes("REQUESTING_CONFIGURATION") ||
      !networks.includes("PRIVATE")
    )
      throwErr("Zerotier authorization failed (contact with admin of the server or try again!)");
  }

  static async leave(id: string) {
    await tryCatch(async () => await run(sudo(`"${Zerotier.FILE}" leave ${id}`), { inherit: true }))
  }

  static getIP() {
    const ip = Object.values(networkInterfaces()).flat().find(
      (interf) => {
        return interf?.family === "IPv4" &&
          !interf.internal &&
          interf.address.startsWith(Zerotier.START_IP);
      }
    )?.address ?? "";
    if (!ip) {
      throwErr(
        "Zerotier ipV4 address of this device not found (try to restart the pc)"
      );
    }
    return ip;
  }

  static async install() {
    await tryCatch(async () => {
      if (await exists(Zerotier.FILE)) return;

      log("Installing zerotier...", "info");
      if (IS_WIN32) {
        const ztInstaller = join(tmpdir(), `zt-${Date.now()}.msi`);
        await retryRun(() => {
          return run(
            [
              `curl.exe -fsSL -o "${ztInstaller}" "${Zerotier.INSTALLER_URL}"`,
              `msiexec /i ${ztInstaller} /qn`,
            ],
            { inherit: true }
          );
        });
      } else {
        await run(`curl -fsSL ${Zerotier.INSTALLER_URL}`, {
          inherit: true,
        });
        await tryCatch(
          () => {
            return run(
              [
                sudo("systemctl start zerotier-one"),
                sudo("firewall-cmd --add-port=9993/udp --permanent"),
                sudo("firewall-cmd --reload"),
                sudo("systemctl restart zerotier-one"),
              ], { inherit: true }
            );
          },
          "Some zerotier settings not set",
          true
        );
        await Zerotier.setupSudoers();
      }
    }, "Zerotier is not installed");
  }

  static async auth(): Promise<string> {
    run(`${IS_WIN32 ? 'start ""' : "xdg-open"} "${Zerotier.NEW_ORG_URL}"`);

    const { value, cancelled } = await UI.input({
      title: "ZeroTier Network Creation",
      desc: `Opening: ${Zerotier.NEW_ORG_URL} ...\n\n1) Create organization with any name\n2) Choose "$0" plan\n3) Copy and Paste (Ctrl+Shift+V) Network ID below:`,
      backText: "Exit",
      filter: /[a-z0-9]/
    });
    UI.restoreMainScreen();

    if (cancelled) throwErr("ZeroTier authorization is required");
    return value;
  }
}
