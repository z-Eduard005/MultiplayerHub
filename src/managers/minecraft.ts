import { join } from "path";
import { exists, tryCatch } from "../utils";
import { readFile, rm, writeFile } from "fs/promises";
import { GAME_DIR } from "../constants";

export default class Minecraft {
  private static serverToNBT(ip: string, name: string) {
    const startNBTFile =
      "\\00\\00\\09\\00\\07\\73\\65\\72\\76\\65\\72\\73\\0A\\00\\00\\";
    const serversLen = "00\\01";
    const ipHexField = "\\08\\00\\02\\69\\70\\";
    const nameHexField = "\\08\\00\\04\\6E\\61\\6D\\65\\";
    const endNBTFile = "\\00\\00";

    const toByteStr = (num: number) => {
      return num.toString(16).padStart(2, "0");
    };
    const toHexWithLen = (str: string) => {
      return `00\\${toByteStr(str.length)}\\${str
        .split("")
        .map((c) => {
          return toByteStr(c.charCodeAt(0));
        })
        .join("\\")}`;
    };

    const hexParts = [
      startNBTFile,
      serversLen,
      ipHexField,
      toHexWithLen(ip),
      nameHexField,
      toHexWithLen(name),
      endNBTFile,
    ]
      .join("")
      .split("\\")
      .filter((p) => p);

    const buffer = Buffer.alloc(hexParts.length);
    hexParts.forEach((part, i) => {
      return part && (buffer[i] = parseInt(part, 16));
    });

    return "\n" + buffer;
  };

  static addServer(ip: string, name: string) {
    const serversBakFile = join(GAME_DIR, "home", name, "servers.dat.bak");
    const serversFile = join(GAME_DIR, "home", name, "servers.dat");

    tryCatch(
      async () => {
        await rm(serversBakFile, { force: true });
        const content = Minecraft.serverToNBT(ip, name);
        let existing = "";
        if (await exists(serversFile)) existing = await readFile(serversFile, "utf8");
        if (existing !== content) await writeFile(serversFile, content, "utf8");
      },
      `The server was not added to the Minecraft menu automatically (try to run "${name}" client at least once)`,
      true
    );
  }
}
