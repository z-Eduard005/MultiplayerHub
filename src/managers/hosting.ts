import { createSocket, type Socket } from "dgram";
import { log, throwErr, tryCatch, run } from "../utils";
import { IS_WIN32 } from "../constants";
import Zerotier from "./zerotier";
import Java from "./java";
import Minecraft from "./minecraft";
import UI from "./ui";
import type { Instance } from "./app";

type BroadcastData = {
  type: "HEARTBEAT" | "WHOIS" | "WHOIS_ACK";
  ip: string;
  nickName: string | null;
  ztNetworkId: string | null;
  instanceId: string | null;
};

export default class Hosting {
  private static readonly BROADCAST_PORT = 42005;
  private static readonly HEARTBEAT_INTERVAL = 3_000;
  private static readonly CONFIRM_TIMEOUT = 1_000;
  private static readonly STALE_TIMEOUT = 20_000;
  private static readonly PROBE_DELAYS = [1000, 1000, 2000, 3000, 5000, 6000];
  private static readonly INITIAL_LISTEN = 2_000;
  private static socket: Socket;
  private static heartBeatTimer: NodeJS.Timeout | undefined;
  private static staleTimer: NodeJS.Timeout | undefined;
  private static confirmTimer: NodeJS.Timeout | undefined;
  private static probeTimer: NodeJS.Timeout | undefined;
  private static whoisProbeActive = false;
  private static probeAttempts = 0;
  private static probeSpinner: { stop: () => void } | null = null;
  private static closed = false;
  private static closeFlag: { value: boolean } = { value: false };
  static closeReason: string | null = null;
  private static resolve: () => void;
  static state: "LOOKING" | "FOLLOWING" | "HOSTING" = "LOOKING";
  static ip: string | null = null;
  static nickName: string | null = null;
  static ztNetworkId: string | null = null;

  static startMonitoring(
    instance: Instance,
    closeFlag: { value: boolean },
    onUpdate: (owner: string, ztNetworkId: string | null) => void
  ): Promise<void> {
    return new Promise(async (resolve) => {
      Hosting.resolve = resolve;
      Hosting.state = "LOOKING";
      Hosting.closed = false;
      Hosting.closeFlag = closeFlag;
      Hosting.closeReason = null;
      Hosting.whoisProbeActive = false;
      Hosting.probeAttempts = 0;

      const closePoll = setInterval(() => {
        if (Hosting.closeFlag.value) {
          clearInterval(closePoll);
          Hosting.cleanup();
          resolve();
        }
      }, 200);

      Hosting.socket = createSocket("udp4");
      Hosting.socket.on("error", (err) => {
        throwErr(`Zerotier Socket error (check your connection): ${err.message}`);
      });

      Hosting.socket.on("listening", () => {
        Hosting.socket.setBroadcast(true);
        Hosting.probeSpinner = UI.spinner();

        setTimeout(() => {
          if (Hosting.state !== "LOOKING") return;
          Hosting.startWhoisProbes(instance);
        }, Hosting.INITIAL_LISTEN);
      });

      Hosting.socket.on("message", (data, rinfo) => {
        let msg: BroadcastData;
        try {
          msg = JSON.parse(data.toString()) as BroadcastData;
        } catch { return; }
        if (msg.ip === Zerotier.ip) return;
        if (msg.instanceId !== instance.id) return;

        if (msg.type === "WHOIS") {
          if (Hosting.state !== "HOSTING") return;
          Hosting.socket.send(
            Buffer.from(JSON.stringify({
              type: "WHOIS_ACK",
              ip: Zerotier.ip,
              nickName: Hosting.nickName,
              ztNetworkId: Hosting.ztNetworkId,
              instanceId: instance.id,
            })),
            Hosting.BROADCAST_PORT,
            rinfo.address,
          );
          return;
        }

        if (msg.type !== "HEARTBEAT" && msg.type !== "WHOIS_ACK") return;
        Hosting.handleHostMessage(msg, instance, onUpdate);
      });

      await tryCatch(
        () => Hosting.socket.bind(Hosting.BROADCAST_PORT),
        `Port ${Hosting.BROADCAST_PORT} is already in use by ${await Hosting.getPortOwner() || "another process"}`
      );
    });
  }

  private static handleHostMessage(msg: BroadcastData, instance: Instance, onUpdate: (owner: string, ztNetworkId: string | null) => void) {
    const newNick = msg.nickName;
    const newZtId = msg.ztNetworkId;
    if (Hosting.nickName !== newNick || Hosting.ztNetworkId !== newZtId) {
      Hosting.nickName = newNick;
      Hosting.ztNetworkId = newZtId;
      onUpdate(newNick ?? "", newZtId);
    }

    if (Hosting.state === "LOOKING") {
      Hosting.state = "FOLLOWING";
      Hosting.ip = msg.ip;
      Hosting.whoisProbeActive = false;
      Hosting.probeSpinner?.stop();
      Hosting.probeSpinner = null;
      clearTimeout(Hosting.probeTimer);
      clearTimeout(Hosting.staleTimer);

      UI.startBadge("Leave Server (Ctrl+O)", Hosting.closeFlag);
      const fullIP = `${msg.ip}:${Java.PORT}`;
      log(`Someone is already playing on ${fullIP}`, "info");
      Minecraft.addServer(fullIP, instance.name);
      Hosting.continueMonitoring(instance);
      return;
    }

    if (Hosting.state === "FOLLOWING" && Hosting.ip === msg.ip) {
      if (Hosting.whoisProbeActive) {
        Hosting.whoisProbeActive = false;
        clearTimeout(Hosting.probeTimer);
      }
      Hosting.continueMonitoring(instance);
      return;
    }

    if (Hosting.state === "HOSTING" && msg.ip < Zerotier.ip!) {
      clearInterval(Hosting.heartBeatTimer);
      clearTimeout(Hosting.confirmTimer);
      Hosting.state = "FOLLOWING";
      Hosting.ip = msg.ip;
      Hosting.whoisProbeActive = false;
      clearTimeout(Hosting.probeTimer);

      const fullIP = `${msg.ip}:${Java.PORT}`;
      log(`Reconnecting to new host on ${fullIP}`, "info");
      Minecraft.addServer(fullIP, instance.name);
      Hosting.continueMonitoring(instance);
    }
  }

  private static startWhoisProbes(instance: Instance) {
    if (Hosting.state === "HOSTING") return;
    Hosting.whoisProbeActive = true;
    Hosting.probeAttempts = 0;
    Hosting.sendWhoisProbe(instance);
  }

  private static sendWhoisProbe(instance: Instance) {
    if (!Hosting.whoisProbeActive) return;
    if (Hosting.state === "HOSTING") return;

    Hosting.probeAttempts++;
    if (Hosting.probeAttempts > Hosting.PROBE_DELAYS.length) {
      Hosting.whoisProbeActive = false;
      Hosting.becomeHost(instance);
      return;
    }

    Hosting.socket.send(
      Buffer.from(JSON.stringify({
        type: "WHOIS",
        ip: Zerotier.ip,
        instanceId: instance.id,
      })),
      Hosting.BROADCAST_PORT,
      Zerotier.broadcastIP!
    );
    const delay = Hosting.PROBE_DELAYS[Hosting.probeAttempts - 1]!;
    Hosting.probeTimer = setTimeout(
      () => Hosting.sendWhoisProbe(instance),
      delay
    );
  }

  private static becomeHost(instance: Instance) {
    if (Hosting.closed || Hosting.state === "HOSTING") return;

    Hosting.state = "HOSTING";
    Hosting.ip = Zerotier.ip;
    Hosting.probeSpinner?.stop();
    Hosting.probeSpinner = null;

    clearInterval(Hosting.heartBeatTimer);
    Hosting.heartBeatTimer = setInterval(async () => {
      await tryCatch(
        () => new Promise<void>((resolve, reject) => {
          const heartbeat = instance.owner === "me"
            ? { type: "HEARTBEAT", ip: Zerotier.ip, nickName: Hosting.nickName, ztNetworkId: Hosting.ztNetworkId, instanceId: instance.id }
            : { type: "HEARTBEAT", ip: Zerotier.ip, instanceId: instance.id };
          Hosting.socket.send(
            Buffer.from(JSON.stringify(heartbeat)),
            Hosting.BROADCAST_PORT,
            Zerotier.broadcastIP!,
            (err) => err ? reject(err) : resolve()
          );
        }),
        (err) => {
          Hosting.closeReason = `Heartbeat broadcast failed (bad connection)\n${err}`;
          Hosting.cleanup();
          Hosting.closeFlag.value = true;
          Hosting.resolve();
        },
      );
    }, Hosting.HEARTBEAT_INTERVAL);

    Hosting.confirmTimer = setTimeout(() => {
      log("Wait, you will be the host now...", "info");
      Minecraft.addServer(`${Zerotier.ip}:${Java.PORT}`, instance.name);
      Hosting.resolve();
    }, Hosting.CONFIRM_TIMEOUT);
  }

  private static continueMonitoring(instance: Instance) {
    clearTimeout(Hosting.staleTimer);
    Hosting.staleTimer = setTimeout(() => {
      if (Hosting.state !== "FOLLOWING") return;
      Hosting.startWhoisProbes(instance);
    }, Hosting.STALE_TIMEOUT);
  }

  private static cleanup() {
    Hosting.whoisProbeActive = false;
    Hosting.probeSpinner?.stop();
    Hosting.probeSpinner = null;
    clearInterval(Hosting.heartBeatTimer);
    clearTimeout(Hosting.staleTimer);
    clearTimeout(Hosting.confirmTimer);
    clearTimeout(Hosting.probeTimer);
  }

  static close(): Promise<void> {
    return new Promise((resolve) => {
      Hosting.closed = true;
      Hosting.cleanup();
      if (!Hosting.socket) { resolve(); return; }
      try {
        Hosting.socket.removeAllListeners("error");
        Hosting.socket.close(() => resolve());
      } catch {
        resolve();
      }

      Hosting.state = "LOOKING";
      Hosting.ip = null;
    });
  }

  private static async getPortOwner(): Promise<string | null> {
    try {
      const out = await run(
        IS_WIN32
          ? `netstat -ano | findstr ":${Hosting.BROADCAST_PORT}"`
          : `ss -tulpn sport = :${Hosting.BROADCAST_PORT} 2>/dev/null`
      );
      if (!out) return null;
      if (IS_WIN32) return out.trim().split(/\s+/).pop() || null;
      return out.match(/users:\(\([^,]+,(\d+)/)?.[1] || null;
    } catch { return null; }
  }
}
