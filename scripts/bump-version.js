const fs = require("fs");
const readline = require("readline");

const APP_FILE = "src/constants.ts";
const PKG_FILE = "package.json";
const current = JSON.parse(fs.readFileSync(PKG_FILE, "utf8")).version;

let completed = false;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on("SIGINT", () => process.exit(1));
rl.on("close", () => { if (!completed) process.exit(1); });

rl.question(`Current version: ${current}\nNew version: `, (input) => {
  const trimmed = input.trim();
  if (!/^\d+\.\d+\.\d+$/.test(trimmed)) {
    console.log("Invalid format — use X.Y.Z");
    process.exit(1);
  }

  const [c0 = 0, c1 = 0, c2 = 0] = current.split(".").map(Number);
  const [n0 = 0, n1 = 0, n2 = 0] = trimmed.split(".").map(Number);
  const isNewer = n0 > c0 || (n0 === c0 && n1 > c1) || (n0 === c0 && n1 === c1 && n2 > c2);
  if (!isNewer) {
    console.log("New version must be greater than current version");
    process.exit(1);
  }

  const content = fs.readFileSync(APP_FILE, "utf8");
  const newContent = content.replace(
    /export const APP_VERSION = "\d+\.\d+\.\d+"/,
    `export const APP_VERSION = "${trimmed}"`,
  );
  fs.writeFileSync(APP_FILE, newContent);

  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, "utf8"));
  pkg.version = trimmed;
  fs.writeFileSync(PKG_FILE, JSON.stringify(pkg, null, 2) + "\n");

  const docsContent = fs.readFileSync("docs/index.html", "utf8");
  const newDocsContent = docsContent.replace(
    /<h1>MultiplayerHub( v\d+\.\d+\.\d+)?<\/h1>/,
    `<h1>MultiplayerHub v${trimmed}</h1>`,
  );
  fs.writeFileSync("docs/index.html", newDocsContent);

  console.log(`Bumped to ${trimmed}`);
  completed = true;
  rl.close();
});
