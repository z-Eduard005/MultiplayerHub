import { createSocket, type Socket } from "dgram";
import { log, throwErr, tryCatch, run } from "../utils";
import { IS_WIN32 } from "../constants";
import Zerotier from "./zerotier";
import Java from "./java";
import Minecraft from "./minecraft";
import UI from "./ui";

type BroadcastData = { type: string; ip: string; nickName: string | null; ztNetworkId: string | null }

export default class Hosting {
  private static readonly BROADCAST_PORT = 42005;
  private static readonly BROADCASTIP = `${Zerotier.START_IP}.255`;
  private static readonly LISTEN_TIMEOUT = 5_000;
  private static readonly HEARTBEAT_INTERVAL = 3_000;
  private static readonly CONFIRM_TIMEOUT = 1_000;
  private static readonly STALE_TIMEOUT = 20_000;
  private static socket: Socket;
  private static heartBeatTimer: NodeJS.Timeout | undefined;
  private static staleTimer: NodeJS.Timeout | undefined;
  private static confirmTimer: NodeJS.Timeout | undefined;
  private static hostFound = false;
  private static resolve: () => void;
  static ip: string | null = null;
  static nickName: string | null = null;
  static ztNetworkId: string | null = null;

  static startMonitoring(
    serverName: string,
    closeFlag: { value: boolean },
    onUpdate: (owner: string, ztNetworkId: string | null) => void
  ): Promise<void> {
    return new Promise(async (resolve) => {
      Hosting.resolve = resolve;
      Hosting.hostFound = false;

      const closePoll = setInterval(async () => {
        if (closeFlag.value) {
          clearInterval(closePoll);
          await Hosting.close();
          resolve();
        }
      }, 200);

      Hosting.socket = createSocket("udp4");
      Hosting.socket.on("error", (err) => {
        throwErr(`Zerotier Socket error (check your connection): ${err.message}`);
      });

      Hosting.socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as BroadcastData;
        if (msg.ip === Zerotier.ip) return;

        const newNick = msg.nickName;
        const newZtId = msg.ztNetworkId;
        if (Hosting.nickName !== newNick || Hosting.ztNetworkId !== newZtId) {
          Hosting.nickName = newNick;
          Hosting.ztNetworkId = newZtId;
          onUpdate(newNick ?? "", newZtId);
        }

        if (!Hosting.hostFound) {
          Hosting.hostFound = true;
          clearInterval(closePoll);
          Hosting.ip = msg.ip;
          const fullIP = `${msg.ip}:${Java.PORT}`;

          log(`Someone is already playing on ${fullIP}`, "info");
          UI.startBadge("Leave Server (Ctrl+O)", closeFlag);
          Minecraft.addServer(fullIP, serverName);
          Hosting.continueMonitoring(serverName);
        } else if (Hosting.ip === msg.ip) {
          Hosting.continueMonitoring(serverName);
        } else if (Hosting.ip === Zerotier.ip && msg.ip < Zerotier.ip!) {
          clearInterval(Hosting.heartBeatTimer);
          clearTimeout(Hosting.confirmTimer);
          Hosting.ip = msg.ip;
          const fullIP = `${msg.ip}:${Java.PORT}`;

          log(`Reconecting to new host on ${fullIP}`, "info");
          Minecraft.addServer(fullIP, serverName);
          Hosting.continueMonitoring(serverName);
        }
      });

      await tryCatch(
        () => Hosting.socket.bind(Hosting.BROADCAST_PORT),
        `Port ${Hosting.BROADCAST_PORT} is already in use by ${await Hosting.getPortOwner() || "another process"}`
      );

      setTimeout(() => {
        clearInterval(closePoll);
        if (Hosting.hostFound) return;
        Hosting.becomeHost(serverName);
      }, Hosting.LISTEN_TIMEOUT);
    });
  }

  private static becomeHost(serverName: string) {
    if (Hosting.ip === Zerotier.ip) return;

    Hosting.ip = Zerotier.ip;

    clearInterval(Hosting.heartBeatTimer);
    Hosting.heartBeatTimer = setInterval(async () => {
      await tryCatch(
        () => Hosting.socket.send(
          Buffer.from(JSON.stringify({
            type: "HEARTBEAT",
            ip: Zerotier.ip,
            nickName: Hosting.nickName,
            ztNetworkId: Hosting.ztNetworkId,
          })),
          Hosting.BROADCAST_PORT,
          Hosting.BROADCASTIP
        ),
        "Hosting connection error (bad internet)"

      );
    }, Hosting.HEARTBEAT_INTERVAL);

    Hosting.confirmTimer = setTimeout(() => {
      log("Wait, you will be the host now...", "info");
      Minecraft.addServer(`${Zerotier.ip}:${Java.PORT}`, serverName);
      Hosting.resolve();
    }, Hosting.CONFIRM_TIMEOUT);
  }

  private static continueMonitoring(serverName: string) {
    clearTimeout(Hosting.staleTimer);
    Hosting.staleTimer = setTimeout(() => Hosting.becomeHost(serverName), Hosting.STALE_TIMEOUT);
  }

  static close(): Promise<void> {
    return new Promise((resolve) => {
      clearInterval(Hosting.heartBeatTimer);
      clearTimeout(Hosting.staleTimer);
      clearTimeout(Hosting.confirmTimer);
      Hosting.socket?.removeAllListeners("error");
      try { Hosting.socket?.close(() => resolve()); } catch { resolve(); }
      Hosting.ip = null;
      Hosting.hostFound = false;
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
