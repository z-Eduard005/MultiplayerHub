const { readFileSync, writeFileSync } = require("fs");
const { execFileSync } = require("child_process");
const { resolve } = require("path");

const exe = resolve(__dirname, "..", "build", "MultiplayerHub.exe");
const icon = resolve(__dirname, "..", "assets", "icon.ico");
const rcedit = resolve(
  __dirname,
  "..",
  "node_modules",
  "rcedit",
  "bin",
  "rcedit-x64.exe",
);

function getOverlayOffset(buf) {
  const peOff = buf.readUInt32LE(0x3c);
  const numSects = buf.readUInt16LE(peOff + 6);
  const optHdrSz = buf.readUInt16LE(peOff + 20);
  let off = peOff + 4 + 20 + optHdrSz + numSects * 40;
  for (let i = 0; i < numSects; i++) {
    const s = peOff + 4 + 20 + optHdrSz + i * 40;
    const end = buf.readUInt32LE(s + 0x14) + buf.readUInt32LE(s + 0x10);
    if (end > off) off = end;
  }
  return off;
}

function findPlaceholders(buf) {
  const re = /(\d+)(\x20{10,})/g;
  const found = [];
  let m;
  while ((m = re.exec(buf)) !== null) {
    const len = m[0].length;
    if ([22, 18].includes(len)) {
      found.push({ offset: m.index, value: parseInt(m[1], 10), len });
    }
  }
  found.sort((a, b) => a.offset - b.offset);
  const payPos = found.find((p) => p.len === 22);
  const rest1 = found.filter((p) => p !== payPos);
  const paySize = rest1.find((p) => p.len === 18);
  const rest2 = rest1.filter((p) => p !== paySize);
  const prePos = rest2.find((p) => p.len === 22);
  const rest3 = rest2.filter((p) => p !== prePos);
  const preSize = rest3.find((p) => p.len === 18);
  return { payPos, paySize, prePos, preSize };
}

// 1. Read original binary, save overlay + placeholder values
const buf = readFileSync(exe);
const overlayOff = getOverlayOffset(buf);
const overlay = buf.slice(overlayOff);
const ph = findPlaceholders(buf);

if (!ph.payPos) throw new Error("PAYLOAD_POSITION placeholder not found");
if (!ph.paySize) throw new Error("PAYLOAD_SIZE placeholder not found");
if (!ph.prePos) throw new Error("PRELUDE_POSITION placeholder not found");
if (!ph.preSize) throw new Error("PRELUDE_SIZE placeholder not found");

const oldPayPosVal = ph.payPos.value;
const paySizeVal = ph.paySize.value;
const oldPrePosVal = ph.prePos.value;
const preSizeVal = ph.preSize.value;

console.log(`PAYLOAD_POSITION: ${oldPayPosVal} PAYLOAD_SIZE: ${paySizeVal}`);
console.log(`PRELUDE_POSITION: ${oldPrePosVal} PRELUDE_SIZE: ${preSizeVal}`);

// 2. Run rcedit (rewrites PE, strips overlay, leaves garbage at end)
if (process.platform === "win32") {
  execFileSync(rcedit, [exe, "--set-icon", icon], { timeout: 30000 });
} else {
  const env = { ...process.env, WINEDLLOVERRIDES: "mscoree,mshtml=" };
  execFileSync("/usr/bin/wine64", [rcedit, exe, "--set-icon", icon], {
    env,
    timeout: 30000,
  });
}

// 3. Truncate to end of last section (remove any leftover data after PE)
const buf2 = readFileSync(exe);
const sectEnd = getOverlayOffset(buf2);
writeFileSync(exe, buf2.slice(0, sectEnd));
console.log(`Truncated to ${sectEnd}`);

// 4. Find placeholders in clean post-rcedit binary, patch them
const buf3 = readFileSync(exe);

const newPayPos = sectEnd; // overlay will be appended here
const newPayPosStr = newPayPos.toString().padEnd(22, " ");
const newPrePos = newPayPos + paySizeVal;
const newPrePosStr = newPrePos.toString().padEnd(22, " ");

// Search for old values to find placeholder positions
const payPosOff = buf3.indexOf(
  Buffer.from(oldPayPosVal.toString().padEnd(22, " ")),
);
const prePosOff = buf3.indexOf(
  Buffer.from(oldPrePosVal.toString().padEnd(22, " ")),
);
if (payPosOff === -1)
  throw new Error("PAYLOAD_POSITION not found in truncated file");
if (prePosOff === -1)
  throw new Error("PRELUDE_POSITION not found in truncated file");

// Patch PAYLOAD_POSITION
writeFileSync(
  exe,
  Buffer.concat([
    buf3.slice(0, payPosOff),
    Buffer.from(newPayPosStr),
    buf3.slice(payPosOff + 22),
  ]),
);

// Patch PRELUDE_POSITION
const buf4 = readFileSync(exe);
writeFileSync(
  exe,
  Buffer.concat([
    buf4.slice(0, prePosOff),
    Buffer.from(newPrePosStr),
    buf4.slice(prePosOff + 22),
  ]),
);

// 5. Append overlay
const buf5 = readFileSync(exe);
writeFileSync(exe, Buffer.concat([buf5, overlay]));

console.log("Icon set, placeholders patched, overlay restored");
