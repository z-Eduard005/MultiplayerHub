const { execSync } = require("child_process");
const fs = require("fs");

execSync("git fetch --prune --prune-tags origin", { stdio: "inherit" });

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
fs.writeFileSync("build/version.js", `window.MPH_VERSION="v${version}";\n`);
execSync(
  `gh release create v${version} build/MultiplayerHub.exe build/MultiplayerHub build/version.js --title "v${version}" --notes ""`,
  { stdio: "inherit" },
);

const releases = JSON.parse(
  execSync("gh release list -L 10 --json tagName", { encoding: "utf8" }),
);
if (releases.length > 5) {
  const old = releases.slice(5);
  console.log(`Cleaning up ${old.length} old release(s)...`);
  for (const r of old) {
    execSync(`gh release delete ${r.tagName} --yes`, { stdio: "inherit" });
    execSync(`git push --delete origin ${r.tagName}`, { stdio: "inherit" });
    execSync(`git tag -d ${r.tagName}`, { stdio: "inherit" });
  }
}
