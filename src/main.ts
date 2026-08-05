import { existsSync } from "fs";
import { join } from "path";
import { APP_START_ART, CONFIG_FILE, INSTANCES_DIR, IS_WIN32 } from "./constants";
import { log, tryCatch, throwErr, run } from "./utils";
import UI, { type ListItem } from "./managers/ui";
import Zerotier from "./managers/zerotier";
import Git from "./managers/git";
import Java from "./managers/java";
import Tlauncher from "./managers/tlauncher";
import Process from "./managers/process";
import App, { type Instance, type Invite } from "./managers/app";

tryCatch(
  async () => {
    await Process.init();
    await App.setup();

    let mainOptionIndex = 0;
    const instanceError: { value: string | null } = { value: null };

    const instanceUi = async (serverName: string) => {
      while (true) {
        const inst = await App.getInstance(serverName);
        if (!inst) { instanceError.value = null; break; }

        const ready = inst.state === "ready";
        const desc = !ready
          ? `\n${UI.textColor("Setup incomplete", "warning")}`
          : inst.owner !== "me"
            ? `\nOwner: ${inst.owner}`
            : `For client-side mods & configs use:\n${join(".tlauncher", "legacy", "Minecraft", "game", "home", serverName)}`

        const footerText = { label: instanceError.value ? `\n${UI.textColor(instanceError.value, "error")}` : "", center: false };

        const deleteLabel = inst.owner === "me" ? "Delete" : "Remove";
        const isNotMine = inst.owner !== "me";
        const ztNetworkItem: ListItem = { label: "# Zerotier Network ID", blocked: true };
        const items: (string | ListItem)[] = ready
          ? [
            "/ Play on Server",
            "_ Copy Invite string",
            "* Change Memory allocation",
            ...(isNotMine
              ? [ztNetworkItem]
              : [{ label: "@ Data Sync Between Players", badge: inst.playersDataSync !== false ? "ON" : "OFF", badgeColor: (inst.playersDataSync !== false ? "green" : "red") as "green" | "red" }]
            ),
            { value: "- Delete server", label: UI.textColor(`- ${deleteLabel} server`, "error") },
          ]
          : [
            "> Continue setup",
            { value: "- Delete server", label: UI.textColor(`- ${deleteLabel} server`, "error") },
          ];

        const opts: Parameters<typeof UI.list>[1] = {
          title: `${serverName.replace(/^0+/, "")} (${inst.version})`,
          desc,
          footerText,
          ...(ready ? (isNotMine
            ? { lockable: true, action: { label: "□ Unlock", run: () => { } } }
            : {
              action: {
                label: "□ Open Server Folder", run: () => {
                  run(`${IS_WIN32 ? 'explorer.exe' : "xdg-open"} "${join(INSTANCES_DIR, serverName, "server")}"`);
                }
              }
            }
          ) : {}),
        };

        const { value, cancelled } = await UI.list(items, opts);

        if (value === "> Continue setup" && inst.state !== "ready") {
          await finishInstanceSetup(serverName, inst.state, inst.version);
          instanceError.value = null;
          break;
        }
        if (value === "_ Copy Invite string") {
          const invite = await App.generateInviteString(serverName);
          await App.copyToClipboard(invite);
        }
        if (value === "* Change Memory allocation") {
          const { value: newRam, cancelled } = await UI.input({
            title: "Memory allocation",
            desc: `Enter amount of RAM in MB\nMinimum: ${Java.MIN_RAM_MB}MB | Maximum: ${Java.MAX_RAM_MB}MB`,
            defaultValue: String(inst?.ram ?? Java.getDefaultRam()),
            validate: (v) => {
              const n = Number(v);
              return isNaN(n) || n < Java.MIN_RAM_MB || n > Java.MAX_RAM_MB
                ? `Must be between ${Java.MIN_RAM_MB} and ${Java.MAX_RAM_MB}`
                : null;
            },
          });
          if (cancelled) continue;
          const value = newRam.trim();
          if (!value) continue;
          await App.updateInstance(serverName, { ram: Number(value) });
        }
        if (value === "/ Play on Server") {
          const valid = await Tlauncher.isValidAccount();
          if (!valid) {
            instanceError.value = 'You should choose microsoft or ely.by account in tlauncher and press "Play" once!';
            continue;
          }
          await App.runInstance(serverName, instanceError);
        }
        if (value === "@ Data Sync Between Players") {
          const current = inst.playersDataSync;
          await App.updateInstance(serverName, { playersDataSync: current === false ? true : false });
          continue;
        }
        if (value === "# Zerotier Network ID") {
          const { value: newId, cancelled } = await UI.input({
            title: "# Zerotier Network ID",
            desc: `${inst.owner}'s Network ID`,
            defaultValue: inst.zerotierID ?? "",
            filter: /[a-z0-9]/,
          });
          if (cancelled) continue;
          if (newId) {
            const patch: Partial<Instance> = {};
            patch.zerotierID = newId;
            await App.updateInstance(serverName, patch);
          }
        }
        if (value === "- Delete server") {
          const { value: confirm, cancelled } = await UI.input({
            title: `Are you sure you want to ${UI.textColor("DELETE", "error")} "${serverName.replace(/^0+/, "")}"?`,
            desc: "Type DELETE to confirm",
            maxLen: 50,
          });
          if (cancelled) continue;
          if (confirm === "DELETE") {
            await App.removeInstance(serverName);
            instanceError.value = null;
            break;
          }
        }
        if (cancelled) { instanceError.value = null; break; }
      }
    };

    const initInstanceVersion = async (serverName: string, neededVersion: string): Promise<boolean> => {
      if ((await Tlauncher.installedVersions()).includes(neededVersion)) {
        await Tlauncher.setupServerVersion(neededVersion, serverName);
        return true;
      }

      let lastTlauncherLaunch = 0;

      while (true) {
        const { value, cancelled } = await UI.list(["> Open TLauncher"], {
          title: "Waiting for version...",
          desc: `You need to install version "${neededVersion}" from TLauncher manually in order to play on this server`,
          resolveOn: async () => {
            const installed = (await Tlauncher.installedVersions()).includes(neededVersion);
            return installed ? neededVersion : null;
          },
        });

        if (value === neededVersion) {
          await Tlauncher.setupServerVersion(neededVersion, serverName);
          return true;
        }
        if (cancelled) return false;

        if (Date.now() - lastTlauncherLaunch >= 5000) {
          lastTlauncherLaunch = Date.now();
          await Tlauncher.open();
        }
      }
    };

    const finishInstanceSetup = async (serverName: string, state: "init" | "invited" | "installed", version: string) => {
      if (state === "invited") {
        const installed = await initInstanceVersion(serverName, version);
        if (installed) await App.updateInstance(serverName, { state: "ready" });
        return instanceUi(serverName);
      }

      if (state === "init") {
        await Java.installServer(serverName, version);
        await App.updateInstance(serverName, { state: "installed" });
      }
      UI.destroyAltScreen();
      log("Server creation...", "info");
      await Git.initServer(serverName);
      await Git.initWorld(serverName, "");
      await App.updateInstance(serverName, { state: "ready" });
      await instanceUi(serverName);
    };

    const chooseServerFlow = async () => {
      while (true) {
        const config = await App.getConfig(CONFIG_FILE);
        const instances = ((config["instances"] as Instance[]) ?? []);
        if (instances.length === 0) return;

        const { value, cancelled } = await UI.list(
          instances.map(i => {
            const item: ListItem = { label: `| ${i.name.replace(/^0+/, "")} (${i.version})`, value: i.name };
            if (i.state !== "ready") {
              item.badge = "Not Ready";
            } else if (i.owner === "me") {
              item.badge = "★ me";
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

        const selected = instances.find(i => i.name === value);
        if (!selected) continue;

        if (selected.state === "ready") {
          await instanceUi(value);
          continue;
        }

        if (selected.state !== "invited" && selected.owner !== "me") {
          log(`Server broken. Contact its owner: ${selected.owner}`, "error");
          continue;
        }

        await instanceUi(value);
      }
    };

    const settingsAction = async () => {
      while (true) {
        const { value, cancelled } = await UI.list(
          [
            { label: "# Zerotier Network ID", blocked: true },
          ],
          {
            title: "Settings",
            desc: "Change these on your own risk",
            lockable: true,
            action: { label: "□ Unlock", run: () => { } }
          }
        );
        if (cancelled) return;

        if (value === "# Zerotier Network ID") {
          const config = await App.getConfig(CONFIG_FILE);
          const { value: newId, cancelled: inputCancelled } = await UI.input({
            title: "# Zerotier Network ID",
            desc: `Your personal Network ID\nYou can get it from - ${Zerotier.ADMIN_URL}`,
            defaultValue: (config["zerotierID"] as string) ?? "",
            filter: /[a-z0-9]/
          });

          if (inputCancelled) continue;
          await App.putConfig(CONFIG_FILE, { zerotierID: newId });

          const instances = (config["instances"] as Instance[]) ?? [];
          for (const inst of instances) {
            if (inst.owner === "me") {
              await App.updateInstance(inst.name, { zerotierID: newId });
            }
          }
        }
      }
    };

    while (true) {
      const { value, cancelled, index } = await UI.list([
        "= Choose Server",
        "> Create Server",
        "+ Add New Server",
      ], {
        title: APP_START_ART,
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

      if (value === "> Create Server") {
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
              title: `${UI.textColor("[1/3]:", "info")} Server creation...`,
              filter: /[a-z_-]/,
              desc: "Type a name for your server instance",
              defaultValue: serverName,
              validate: (name) => {
                if (name.length > 20) return "Server name too long (max 20)";
                return existing.some(i => i.name.toLowerCase() === name.toLowerCase()) ? "This server name already exists" : null;
              }
            });

            if (cancelled) { step = 0; break; }
            serverName = value;
            const validAccount = await Tlauncher.isValidAccount();
            if (!validAccount) throwErr('You should choose microsoft or ely.by account in tlauncher and press "Play" once!');

            step = 2;
          }
          if (step === 2) {
            const getAvailableVersions = async () => {
              return (await Tlauncher.installedVersions(existing.map(i => i.name))).map(Java.toVersionOption)
            }
            const versionItems = await getAvailableVersions();

            const { value, cancelled, index } = await UI.list(versionItems, {
              title: `${UI.textColor("[2/3]:", "info")} Server creation...`,
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
            UI.destroyAltScreen();
            log("Server creation...", "info");
            await Git.initServer(serverName);

            const { value } = await UI.input({
              title: `${UI.textColor("[3/3]:", "info")} Server creation...`,
              desc: "Path to existing world folder, or press Enter to skip",
              allowEmpty: true,
              validate: (p) => p && !existsSync(p) ? "Path does not exist" : null,
            });

            await Git.initWorld(serverName, value);
            await App.generateInviteString(serverName);
            await App.updateInstance(serverName, { state: "ready" });

            step = 4;
          }
        }
        if (step === 4) {
          await instanceUi(serverName);
          await chooseServerFlow();
          continue;
        }

        if (step < 4) continue;
      }
      if (value === "+ Add New Server") {
        const config = await App.getConfig(CONFIG_FILE);
        const instances = (config["instances"] as Instance[]) ?? [];

        const { value: invite, cancelled } = await UI.input({
          title: `Paste invite string (${IS_WIN32 ? "Ctrl+V" : "Ctrl+Shift+V"})`,
          desc: "Ask the server creator for an invite string",
          maxLen: 2048,
          validate: (v: string) => {
            try {
              const data = App.decode(v) as Invite;
              if (instances.some(i => i.id === data?.id)) return "Server already added";
            } catch { }
            return null;
          },
        });

        if (cancelled) continue;
        const invitedName = await App.decodeInviteString(invite);
        const invitedInst = await App.getInstance(invitedName);

        const installed = await initInstanceVersion(invitedName, invitedInst!.version);
        if (installed) {
          await finishInstanceSetup(invitedName, "invited", invitedInst!.version);
        }
        continue;
      };
    }
  },
  async (err) => {
    UI.destroyAltScreen();
    log(err, "error");
    await Process.stop();
  }
);
