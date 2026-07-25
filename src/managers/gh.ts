import { IS_WIN32 } from "../constants";
import { log, run, tryCatch, isSuccess, retryRun, throwErr } from "../utils";
import App from "./app";

export default class GH {
  private static readonly AUTH_URL = "https://github.com/login/device";
  private static readonly GIT_PACKAGES = IS_WIN32 ? ["Git.Git", "GitHub.cli"] : { "git": "git", "gh": "gh" };
  private static owner: string | null = null;

  private static repoName(name: string): string {
    return `MH-${name}`;
  }

  private static async isInstalled(pkg: string) {
    return await isSuccess(async () => await run(IS_WIN32 ? `where ${pkg}` : `which ${pkg}`));
  };

  static async install() {
    if (await GH.isInstalled("git") && await GH.isInstalled("gh")) return;
    log("Installing dependencies...", "info");

    if (IS_WIN32) {
      if (!(await GH.isInstalled("winget"))) {
        await tryCatch(
          async () => {
            return await retryRun(async () => {
              return await run(
                [
                  'powershell -Command "Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser"',
                  'powershell -Command "Install-Script winget-install -Force"',
                  'powershell -Command "winget-install"',
                ],
                { inherit: true }
              );
            });
          },
          "Winget is not installed"
        );
        if (!(await GH.isInstalled("winget"))) throwErr("Winget is not installed");
      }

      await tryCatch(
        () => run(`winget install ${(GH.GIT_PACKAGES as string[]).join(" ")}`, { inherit: true }),
        "Git packages are not installed, this might have happened earlier",
        true
      );
    } else {
      App.pmInstall(GH.GIT_PACKAGES as Record<string, string>);
    }
  }

  static async auth() {
    const authed = await isSuccess(async () => await run("gh auth status"));
    if (!authed) {
      log("GitHub account required for the program", "info");

      run(`${IS_WIN32 ? 'start ""' : "xdg-open"} "${GH.AUTH_URL}"`);
      await run(
        'echo "\r" | gh auth login --web --clipboard --git-protocol https --skip-ssh-key --scopes "repo,delete_repo"',
        { inherit: true }
      );

      await tryCatch(async () => await run("gh auth status"), "GitHub authentication check failed");
    }

    await tryCatch(async () => {
      for (const field of ["name", "email"]) {
        const exists = await isSuccess(async () => await run(`git config --global user.${field}`));
        if (!exists) await run(`git config --global user.${field} "you@example.com"`);
      }
    }, "Git initialization failed");
  }

  static async repoDelete(name: string): Promise<void> {
    const repo = GH.repoName(name);
    await tryCatch(
      () => run(`gh repo delete "${repo}" --yes`, { inherit: true }),
      `Failed to delete stale repository "${repo}"`,
      true
    );
  }

  static async repoCreate(name: string): Promise<string> {
    const repo = GH.repoName(name);
    await tryCatch(
      () => run(`gh repo create "${repo}" --private`, { inherit: true }),
      `Failed to create repository "${repo}"`
    );
    return await GH.getSshUrl(repo);
  }

  static async getOwner(): Promise<string> {
    if (GH.owner) return GH.owner;
    GH.owner = await tryCatch(
      () => run('gh api user --jq ".login"'),
      "Failed to get GitHub username"
    );
    return GH.owner;
  }

  static async addDeployKey(name: string, pubKey: string): Promise<void> {
    const repo = GH.repoName(name);
    const owner = await GH.getOwner();
    await tryCatch(
      () => run(
        `gh api repos/${owner}/${repo}/keys -X POST -f title="MH-${repo}" -f key="${pubKey}" -f read_only=false`,
        { inherit: true }
      ),
      `Failed to add deploy key to ${owner}/${repo}`
    );
  }

  private static async getSshUrl(name: string): Promise<string> {
    const owner = await GH.getOwner();
    return `git@github.com:${owner}/${name}.git`;
  }
}
