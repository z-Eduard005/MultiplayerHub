import { existsSync } from "fs";
import { log, tryCatch, throwErr, color } from "./utils";
import UI, { type ListItem } from "./managers/ui";
import Zerotier from "./managers/zerotier";
import Git from "./managers/git";
import Java from "./managers/java";
import Tlauncher from "./managers/tlauncher";
import Process from "./managers/process";
import Hosting from "./managers/hosting";
import App, { type Instance } from "./managers/app";
import { CONFIG_FILE, GAME_DIR } from "./constants";
import { join } from "path";

tryCatch(
  async () => {
    await Process.init();
    await App.setup();

    let mainOptionIndex = 0;
    Zerotier.ip = Zerotier.getIP();

    const runInstance = async () => {
      UI.restoreMainScreen();

      Java.getRam();

      await Tlauncher.checkAccountType();

      await Zerotier.start();
      await Zerotier.join("TEST");

      await Tlauncher.chooseVersion("TEST");
      await Tlauncher.open();

      await Hosting.startMonitoring();

      // await Git.worldInit();

      await Java.generateServerSettings(Zerotier.ip!, "TEST");
      await Java.start("TEST");

      Java.process?.on("error", async (err) => {
        throwErr(`Error starting Java server. Check path to Java: ${Java.getJavaPath("TEST")}\n${err}`);
      });
      Java.process?.on("close", async (code) => {
        if (code !== 0) {
          throwErr(`Server terminated with an error (code: ${code})`);
        }
        await Process.stop("Server successfully stopped");
      });
      Java.process?.stdout.on("data", async (data) => {
        process.stdout.write(data);

        const ADMIN_NAME = "TEST";

        if (data.includes(`${ADMIN_NAME} joined the game`)) {
          Java.runMCCommand(`op ${ADMIN_NAME}`);
        }

        if (data.includes("Unloading dimension 1")) {
          log(`You have started the server on port: ${Zerotier.ip}:${Java.PORT}\nHave fun playing :)`, "success");

          Git.worldEnableRepeatedPush();
        }
      });
    };

    const instanceEntryUi = async (serverName: string) => {
      while (true) {
        const { value, cancelled } = await UI.list(
          [
            "/ Launch Instance",
            "_ Copy Invite string",
            "* Change Memory allocation",
          ],
          {
            title: `Server Instance "${serverName}"`,
            desc: `\nYou can add mods and configs by just placing them in:\n"${join(GAME_DIR, "home", serverName)}"`
          }
        );
        if (value === "_ Copy Invite string") {
          const cfg = await App.getConfig(CONFIG_FILE);
          const instances = (cfg["instances"] as Instance[]) ?? [];
          const inst = instances.find(i => i.name === serverName);
          if (inst?.inviteString) await App.copyToClipboard(inst.inviteString);
        }
        if (value === "* Change Memory allocation") {
          await UI.input({
            title: "Memory allocation",
            desc: `Enter amount of RAM in MB\nMinimum: 2700MB | Maximum: 7168MB`,
            defaultValue: String(Java.ram),
          });
        }
        if (value === "/ Launch Instance") {
          await runInstance();
          break;
        }
        if (cancelled) break;
      }
    };

    const chooseServerFlow = async () => {
      while (true) {
        const config = await App.getConfig(CONFIG_FILE);
        const instances = ((config["instances"] as Instance[]) ?? []);
        if (instances.length === 0) return;

        const { value, cancelled } = await UI.list(
          instances.map(i => {
            const item: ListItem = { label: i.name };
            if (i.state !== "ready") {
              item.badge = "Not Ready";
            } else if (i.owner === "me") {
              item.badge = "★";
              item.badgeColor = "green";
            } else {
              item.badge = `☆ ${i.owner}`;
              item.badgeColor = "yellow";
            }
            return item;
          }),
          { title: "Choose Server", desc: "Select an instance to play on" }
        );

        if (cancelled) return;
        await instanceEntryUi(value);
      }
    };

    const settingsAction = async () => {
      while (true) {
        const { value, cancelled } = await UI.list(
          [
            { label: "Zerotier Network ID", badge: "locked", blocked: true },
            { label: "test", badge: "locked", blocked: true }
          ],
          {
            title: "Settings",
            desc: "Change these on your own risk",
            lockable: true,
            action: { label: "□ Unlock", run: () => { } }
          }
        );
        if (cancelled) return;

        if (value === "Zerotier Network ID") {
          const config = await App.getConfig(CONFIG_FILE);
          const { value: newId, cancelled: inputCancelled } = await UI.input({
            title: "ZeroTier Network ID",
            desc: `Your personal Network ID\nYou can get it from - ${Zerotier.ADMIN_URL}`,
            defaultValue: (config["zerotierID"] as string) ?? "",
            filter: /[a-z0-9]/
          });

          if (inputCancelled) continue;
          await App.putConfig(CONFIG_FILE, { zerotierID: newId });
        }
      }
    };

    while (true) {
      const { value, cancelled, index } = await UI.list([
        "= Choose Server",
        "> Create Server Instance",
        "+ Add New Server",
      ], {
        title: UI.START_ART,
        backText: "Exit",
        defaultValue: mainOptionIndex,
        action: { label: "⛭ Settings", run: settingsAction },
        footerText: "'Ctrl + Scroll' to zoom"
      });
      mainOptionIndex = index;

      if (cancelled) await Process.stop();

      if (value === "= Choose Server") {
        await chooseServerFlow();
        continue;
      }

      if (value === "> Create Server Instance") {
        let lastTlauncherLaunch = 0;
        let serverName = "";
        let serverVersion = "";
        let serverVersionIndex = -1;
        let step = 1;
        let existing: Instance[] = [];

        while (step > 0 && step < 4) {
          if (step === 1) {
            const config = await App.getConfig(CONFIG_FILE);
            existing = (config["instances"] as Instance[]) ?? [];

            const { value, cancelled } = await UI.input({
              title: `${color("[1/3]:", "info")} Server creation...`,
              filter: /[a-zA-Z_-]/,
              desc: "Type a name for your server instance",
              defaultValue: serverName,
              validate: (name) => {
                if (name.length > 20) return "Server name too long (max 20)";
                return existing.some(i => i.name === name) ? "This server name already exists" : null;
              }
            });

            if (cancelled) { step = 0; break; }
            serverName = value;

            step = 2;
          }
          if (step === 2) {
            const getAvailableVersions = async () => {
              return (await Tlauncher.installedVersions(existing.map(i => i.name))).map(Java.toVersionOption)
            }
            const versionItems = await getAvailableVersions();

            const { value, cancelled, index } = await UI.list(versionItems, {
              title: `${color("[2/3]:", "info")} Server creation...`,
              desc: "Choose Minecraft version (install from tlauncher)\n\nNot Supported:\n- fabric below 1.14\n- forge above 1.13.2",
              refresh: () => getAvailableVersions(),
              action: {
                label: "> Open TLauncher", run: () => {
                  if (Date.now() - lastTlauncherLaunch < 5000) return;
                  lastTlauncherLaunch = Date.now();
                  return Tlauncher.open();
                }
              },
              defaultValue: serverVersionIndex
            });

            serverVersionIndex = index;
            if (cancelled) { step = 1; continue; }
            serverVersion = value;
            await App.initInstance(serverName, serverVersion);
            await Java.installServer(serverName, serverVersion);

            await App.updateInstance(serverName, { state: "installed" });

            step = 3;
          }
          if (step === 3) {
            UI.restoreMainScreen();
            log("Server creation...", "info");
            await Git.initServer(serverName);

            const { value } = await UI.input({
              title: `${color("[3/3]:", "info")} Server creation...`,
              desc: "Path to existing world folder, or press Enter to skip",
              allowEmpty: true,
              validate: (p) => p && !existsSync(p) ? "Path does not exist" : null,
            });

            await Git.initWorld(serverName, value);
            const invite = await App.generateInviteString(serverName);
            await App.updateInstance(serverName, { state: "ready", inviteString: invite });

            step = 4;
          }
        }
        if (step === 4) {
          await instanceEntryUi(serverName);
          await chooseServerFlow();
          continue;
        }

        if (step < 4) continue;
      }
      if (value === "+ Add New Server") {
        continue;
      };
    }
  },
  async (err) => {
    UI.restoreMainScreen();
    log(err, "error");
    await Process.stop();
  }
);
