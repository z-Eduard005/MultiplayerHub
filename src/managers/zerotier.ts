import { spawn } from "child_process";
import { IS_WIN32, USER_NAME } from "../constants";
import { exists, retryRun, run, log, sudo, throwErr, tryCatch, isSuccess } from "../utils"
import { setTimeout as setTimeoutPromise } from "timers/promises";
import { join } from "path";
import { networkInterfaces, tmpdir } from "os";
import UI from "./ui";

export default class Zerotier {
  static readonly ADMIN_URL = "https://central.zerotier.com";
  private static readonly NEW_ORG_URL = `${Zerotier.ADMIN_URL}/org/new`;
  static readonly FILE = IS_WIN32
    ? join("C:", "Program Files (x86)", "ZeroTier", "One", "zerotier-cli.bat")
    : join("/usr", "bin", "zerotier-cli");

  private static readonly INSTALLER_URL = IS_WIN32
    ? "https://download.zerotier.com/dist/ZeroTier%20One.msi"
    : "https://install.zerotier.com";

  private static readonly SUDOERS_FILE = join("/etc", "sudoers.d", "zerotier");
  private static readonly SUDOERS_CONTENT = `${USER_NAME} ALL=(ALL) NOPASSWD: ${Zerotier.FILE} *`;
  private static readonly CMD_TIMEOUT = 4000;

  static broadcastIP: string | null = null;
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

  static async join(id: string, amIOwner: boolean) {
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
    ) {
      throwErr(`Zerotier authorization failed\n${amIOwner ? `Authorise yourself: https://my.zerotier.com/network/${id}` : "Contact with owner of the server!"}`);
    }
  }

  static async leave(id: string) {
    await tryCatch(async () => await run(sudo(`"${Zerotier.FILE}" leave "${id}"`), { inherit: true }))
  }

  static async leaveAll() {
    const out = await tryCatch(
      async () => run(sudo(`"${Zerotier.FILE}" -j listnetworks`)),
      "Failed to list zerotier networks"
    );
    if (!out) return;

    type ZtNet = { nwid: string };
    const networks: ZtNet[] = JSON.parse(out);
    for (const net of networks) {
      await Zerotier.leave(net.nwid);
    }
  }

  static ipToInt(ip: string): number {
    const parts = ip.split(".");
    const [a, b, c, d] = parts as [string, string, string, string];
    return ((+a << 24) | (+b << 16) | (+c << 8) | +d) >>> 0;
  }

  private static intToIp(num: number): string {
    return [
      (num >>> 24) & 255,
      (num >>> 16) & 255,
      (num >>> 8) & 255,
      num & 255
    ].join(".");
  }

  static async getIP() {
    const ztIf = Object.entries(networkInterfaces())
      .filter(([name]) => IS_WIN32 ? name.includes("ZeroTier") : name.startsWith("zt"))
      .flatMap(([, addrs]) => addrs ?? [])
      .find(interf => interf?.family === "IPv4" && !interf.internal);

    if (!ztIf) throwErr("ZeroTier IPv4 address not found.\nMaybe Zerotier Netword ID changed.\nPlease contact with server owner and change this server Network ID");

    const maskNum = Zerotier.ipToInt(ztIf!.netmask);
    const ipNum = Zerotier.ipToInt(ztIf!.address);
    Zerotier.broadcastIP = Zerotier.intToIp((ipNum | (~maskNum >>> 0)) >>> 0);

    return ztIf!.address;
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
        await run(`curl -fsSL ${Zerotier.INSTALLER_URL}`, { inherit: true });
        await tryCatch(
          async () => {
            await run(sudo("systemctl start zerotier-one"), { inherit: true });

            const firewalldActive = await isSuccess(async () => await run(`systemctl is-active --quiet firewalld`));
            if (firewalldActive) {
              await run(
                [
                  sudo("firewall-cmd --add-port=9993/udp --permanent"),
                  sudo("firewall-cmd --reload"),
                ], { inherit: true }
              );
            }

            await run(sudo("systemctl restart zerotier-one"), { inherit: true });
          },
          "Firewall blocked zerotier service"
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
