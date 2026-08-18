import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";

export const IS_WIN32 = process.platform === "win32";
export const LINUX_SHELL = "/bin/bash";
export const USER_NAME = process.env["USER"] || process.env["USERNAME"]!;
export const USER_DIR = homedir();

export const MC_REL_PATH = join(
  "AppData",
  "Roaming",
  ".tlauncher",
  "legacy",
  "Minecraft"
);

export const PFX_FLAG_FILE = join(
  USER_DIR,
  "Programs",
  "proton-legacylauncher",
  ".pfx-created"
);

export const MC_DIR = join(
  IS_WIN32
    ? join(USER_DIR, MC_REL_PATH)
    : existsSync(PFX_FLAG_FILE)
      ? join(
        USER_DIR,
        ".steam",
        "steam",
        "steamapps",
        "compatdata",
        readFileSync(PFX_FLAG_FILE, "utf8").trim(),
        "pfx",
        "drive_c",
        "users",
        "steamuser",
        MC_REL_PATH
      )
      : String(null)
);

export const GAME_DIR = join(MC_DIR, "game");
export const DESKTOP_DIR = join(USER_DIR, "Desktop");
export const APP_VERSION = "1.4.8";
export const APP_NAME = "MultiplayerHub";
export const APP_DIR = IS_WIN32
  ? join(USER_DIR, "AppData", "Roaming", "MultiplayerHub")
  : join(USER_DIR, ".MultiplayerHub");
export const INSTANCES_DIR = join(APP_DIR, "instances");
export const CONFIG_FILE = join(APP_DIR, ".config");
export const VERSIONS_DIR = join(GAME_DIR, "versions");
export const SERVER_READY_RGX = /Done \(\d+\.\d+s\)!/;
export const APP_START_ART = `
╔═╦═╗     ╗  ╦        ╗                 ╦  ╦     ╦  
║ ║ ║     ║  ║  o     ║                 ║  ║     ║   
║ ║ ║ ╦ ╦ ║ ═╬═ ╦ ╔═╗ ║ ╔═╗ ╦ ╦ ╔═╗ ╦═╗ ╠══╣ ╦ ╦ ╠═╗ 
║ ║ ║ ║ ║ ║  ║  ║ ║ ║ ║ ╔═╣ ║ ║ ╠═╝ ║   ║  ║ ║ ║ ║ ║ 
╩ ╩ ╩ ╚═╝ ╩  ╚╝ ╩ ╠═╝ ╩ ╚═╚ ╚═╣ ╚═╝ ╩   ╩  ╩ ╚═╝ ╚═╝ 
                  ║           ║                      
                  ╩         ╚═╝                      `;