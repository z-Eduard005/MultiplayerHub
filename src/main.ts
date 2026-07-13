import { existsSync } from "fs";
import { join } from "path";
import { CONFIG_FILE, GAME_DIR, IS_WIN32, SERVER_READY_RGX } from "./constants";
import { log, tryCatch, throwErr, color } from "./utils";
import UI, { type ListItem } from "./managers/ui";
import Zerotier from "./managers/zerotier";
import Git from "./managers/git";
import Java from "./managers/java";
import Tlauncher from "./managers/tlauncher";
import Process from "./managers/process";
import Hosting from "./managers/hosting";
import App, { type Instance } from "./managers/app";

tryCatch(
  async () => {
    await Process.init();
    await App.setup();

    let mainOptionIndex = 0;

    let instanceError: string | null = null;

    const closeInstance = async (serverName: string, instance: Instance, ztNetworkId: string) => {
      UI.stopBadge();

      await Java.kill();

      Git.worldDisableRepeatedPush();
      if (Hosting.ip === Zerotier.ip && Git.worldInitialized) {
        await tryCatch(
          () => Git.syncWorld(serverName, instance.repoUrl ?? ""),
          err => log(err, "error")
        );
      }
      await Hosting.close();

      await Zerotier.leave(ztNetworkId);
    }

    const runInstance = async (serverName: string) => {
      UI.restoreMainScreen();
      instanceError = null;
      const closeFlag = { value: false };

      const config = await App.getConfig(CONFIG_FILE);
      const instances = (config["instances"] as Instance[]) ?? [];
      const instance = instances.find(i => i.name === serverName);
      if (!instance) return;
      const ztNetworkId = instance.zerotierID ?? config["zerotierID"] as string;

      await tryCatch(async () => {
        const ram = instance.ram ?? Java.getDefaultRam();
        if (ram < Java.MIN_RAM_MB) throwErr("You don't have enough memory to play on the server :(");

        await Zerotier.start();
        await Zerotier.join(ztNetworkId);
        Zerotier.ip = Zerotier.getIP();

        await Tlauncher.chooseVersion(serverName);
        Tlauncher.open();

        const adminName = await Tlauncher.getAccountName();
        Hosting.nickName = adminName;
        Hosting.ztNetworkId = ztNetworkId;
        await Hosting.startMonitoring(instance, closeFlag, (owner, ztNetworkId) => {
          const patch: Partial<Instance> = {};
          if (instance.owner !== "me") {
            if (instance.owner !== null) patch.owner = owner;
            if (ztNetworkId !== null) patch.zerotierID = ztNetworkId;
          }
          App.updateInstance(serverName, patch);
        });

        if (closeFlag.value) {
          if (Hosting.closeReason) instanceError = Hosting.closeReason;
          await closeInstance(serverName, instance, ztNetworkId);
          return;
        }
        // await Git.serverFetch();
        // await Git.worldSync();

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
          Java.process?.stdout.on("data", (data) => {
            process.stdout.write(data);

            if (data.includes(`${adminName} joined the game`)) {
              Java.runMCCommand(`op ${adminName}`);
            }

            if (SERVER_READY_RGX.test(data)) {
              log(`You have started the server on port: ${Zerotier.ip}:${Java.PORT}`, "success");
              UI.startBadge("Close and Save Progress! (Ctrl+O)", closeFlag);

              Git.worldEnableRepeatedPush(serverName, instance.repoUrl ?? "");
            }
          });
        });

        clearInterval(closePoll);
        if (closeFlag.value) await closeInstance(serverName, instance, ztNetworkId);
      }, async (err) => {
        instanceError = err;
        await closeInstance(serverName, instance, ztNetworkId);
      });
    };

    const instanceEntryUi = async (serverName: string) => {
      while (true) {
        const inst = await App.getInstance(serverName);
        if (!inst) { instanceError = null; break; }

        const ready = inst.state === "ready";
        const desc = !ready
          ? `\n${color("Setup incomplete", "warning")}`
          : inst.owner !== "me"
            ? `\nOwner: ${inst.owner}`
            : `\nYou can add mods and configs by just placing them in:\n"${join(GAME_DIR, "home", serverName)}"`
        const footerText = { label: instanceError ? `\n${color(instanceError, "error")}` : "", center: false };

        const deleteLabel = inst.owner === "me" ? "Delete" : "Remove";
        const items: (string | ListItem)[] = ready
          ? [
            "/ Play on Server",
            "_ Copy Invite string",
            "* Change Memory allocation",
            { value: "- Delete server", label: color(`- ${deleteLabel} server`, "error") },
          ]
          : [
            "> Continue setup",
            { value: "- Delete server", label: color(`- ${deleteLabel} server`, "error") },
          ];

        const opts: Parameters<typeof UI.list>[1] = {
          title: `${serverName.replace(/^0+/, "")} (${inst.version})`,
          desc,
          footerText,
        };

        const { value, cancelled } = await UI.list(items, opts);

        if (value === "> Continue setup" && inst.state !== "ready") {
          await finishServerSetup(serverName, inst.state, inst.version);
          instanceError = null;
          break;
        }
        if (value === "_ Copy Invite string") {
          let invite = inst?.inviteString
          if (!invite) {
            invite = await App.generateInviteString(serverName);
            await App.updateInstance(serverName, { inviteString: invite });
          }
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
            instanceError = 'You should choose microsoft or ely.by account in tlauncher and press "Play" once!';
            continue;
          }
          await runInstance(serverName);
        }
        if (value === "- Delete server") {
          const { value: confirm, cancelled } = await UI.input({
            title: `Are you sure you want to ${color("DELETE", "error")} "${serverName.replace(/^0+/, "")}"?`,
            desc: "Type DELETE to confirm",
            maxLen: 50,
          });
          if (cancelled) continue;
          if (confirm === "DELETE") {
            await App.removeInstance(serverName);
            instanceError = null;
            break;
          }
        }
        if (cancelled) { instanceError = null; break; }
      }
    };

    const finishServerSetup = async (serverName: string, state: "init" | "installed", version: string) => {
      if (state === "init") {
        await Java.installServer(serverName, version);
        await App.updateInstance(serverName, { state: "installed" });
      }
      UI.restoreMainScreen();
      log("Server creation...", "info");
      await Git.initServer(serverName);
      await Git.initWorld(serverName, "");
      const invite = await App.generateInviteString(serverName);
      await App.updateInstance(serverName, { state: "ready", inviteString: invite });
      await instanceEntryUi(serverName);
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
          await instanceEntryUi(value);
          continue;
        }

        if (selected.owner !== "me") {
          log(`Server broken. Contact its owner: ${selected.owner}`, "error");
          continue;
        }

        await instanceEntryUi(value);
      }
    };

    const settingsAction = async () => {
      while (true) {
        const { value, cancelled } = await UI.list(
          [
            { label: "Zerotier Network ID", blocked: true },
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
              title: `${color("[1/3]:", "info")} Server creation...`,
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
        const config = await App.getConfig(CONFIG_FILE);
        const myInvites = ((config["instances"] as Instance[]) ?? [])
          .filter(i => i.owner === "me" && i.inviteString)
          .map(i => i.inviteString);

        const { value: invite, cancelled } = await UI.input({
          title: `Paste invite string (${IS_WIN32 ? "Ctrl+V" : "Ctrl+Shift+V"})`,
          desc: "Ask the server creator for an invite string",
          maxLen: 2048,
          validate: (v: string) => {
            return myInvites.includes(v) ? "You can't add your own server" : null;
          },
        });

        if (cancelled) continue;
        await App.decodeInviteString(invite);
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
