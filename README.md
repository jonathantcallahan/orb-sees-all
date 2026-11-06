# Demian

A desktop app for macOS and Windows that pulls your day together from Slack, Gmail, Google Calendar, Google Drive, Zoom and Jira. Each project gets a status, blockers and your tasks. It also keeps a task list built from DMs, mentions and email, plus today's meetings with prep. Every weekday morning it refreshes itself.

The app has no API keys or OAuth apps of its own. It runs [Claude Code](https://docs.claude.com/en/docs/claude-code) headless (`claude -p`) and uses the connectors on your claude.ai account. Those jobs can only read. The one exception is Slack: the app posts a message there only after you write it and click **Send**.

Everything the app stores stays on your machine. It's a SQLite database in `~/Library/Application Support/com.orb.app/`.

## Requirements

- A Mac (Apple silicon or Intel), or Windows 10 or later
- A Claude account with a Pro, Max, Team or Enterprise plan
- [Claude Code](https://docs.claude.com/en/docs/claude-code/setup), signed in with that account. The app walks you through installing it.
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`), signed in, if you want PR status on project cards

## 1. Install Demian

### macOS

1. Download `Demian_<version>_universal.dmg` from the [latest release](https://github.com/jonathantcallahan/orb-sees-all/releases/latest).
2. Open the `.dmg` and drag **Demian** into **Applications**.
3. The app isn't signed by Apple yet, so macOS blocks it the first time ("damaged", or "can't be opened"). Open Terminal, paste this and press Return:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Demian.app"
   ```

   Then open Demian normally. You only need this once; updates install without it.

### Windows

1. Download `Demian_<version>_x64-setup.exe` from the [latest release](https://github.com/jonathantcallahan/orb-sees-all/releases/latest) and run it.
2. If SmartScreen warns you, choose **More info**, then **Run anyway**.

**Updates:** the app checks GitHub for a new version at launch and every few hours. When one is out, an **Update to x.y.z** button appears in the header. Click it, and the app downloads the update and restarts.

## 2. First run

On first launch, Demian walks you through three steps, checking each as you go. Each step has a button that does it for you, the command to paste if you'd rather, and **Check again**.

1. **Install Claude Code.** On macOS, in Terminal:

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   On Windows, in PowerShell (Claude Code also needs [Git for Windows](https://git-scm.com/downloads/win)):

   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```

2. **Sign Claude Code in** with your Claude account. Being signed in at claude.ai in your browser isn't enough; Claude Code signs in on its own. Open a new Terminal (or PowerShell) window and run:

   ```bash
   claude auth login --claudeai
   ```

   On Windows, Claude's installer puts `claude.exe` in `%USERPROFILE%\.local\bin` but may leave that folder off your PATH (it says so under "Setup notes"), so PowerShell answers "'claude' is not recognized". Demian finds it there anyway, and its **Sign in** button runs it by its full path. To sign in by hand, run it by its full path:

   ```powershell
   & "$env:USERPROFILE\.local\bin\claude.exe" auth login --claudeai
   ```

   or add the folder to your PATH for good, then open a new PowerShell window and use `claude` as usual:

   ```powershell
   [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + "$env:USERPROFILE\.local\bin", 'User')
   ```

3. **Connect your accounts** at [claude.ai → Customize → Connectors](https://claude.ai/new#customize/connectors/yours), signing in with your work account:

   | Connector | Used for | Needed? |
   | --- | --- | --- |
   | Slack | Projects, tasks, replies, news | Yes |
   | Gmail | Email tasks and replies | Yes |
   | Google Calendar | Today's meetings, prep and finding times | Yes |
   | Google Drive | Finding docs, and creating the ones you approve | Optional |
   | Google Docs, Sheets and Slides | Reading files linked in your work | Optional |
   | Claude Docs | Reading docs people share from Claude | Optional |
   | Zoom | Meeting summaries | Optional |

   Jira isn't a claude.ai connector. It's read through an MCP server named `mcp-jira` that your team sets up in Claude Code (`claude mcp add mcp-jira …`, using whatever Jira MCP server your company runs). It may need your company's VPN. Without it, Claude simply has no Jira.

Then Demian learns your role from your work and starts the first refresh. You can run the checks again any time from **Settings → Check setup**.

**If you route Claude Code through a gateway** (`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`): a gateway login replaces the claude.ai login and turns off the connectors in your own Claude Code sessions. The app clears both for its own runs, so it works as long as Claude Code has also been signed in with your Claude account (step 2).

To check by hand that headless Claude Code can see the connectors:

```bash
claude -p "List the Slack, Gmail and Google Calendar tools you have. Just their names."
```

## 3. Using it

To change things later:

1. Open **Settings** (the button in the header):
   - **About you:** one line on your role, e.g. "an engineering manager on the payments team". Claude uses it to decide what matters to you.
   - **Model:** Opus is the most accurate; Sonnet is cheaper and faster.
   - **Morning refresh:** when the automatic refresh runs (7:30 on weekdays by default).
2. Click **Refresh all**. The first run does three things:
   - finds your project channels;
   - reads the last two weeks of each one;
   - builds your task list and today's calendar.

   That takes a few minutes. Later refreshes only read what's new.
3. **Projects:**
   - Channels named `#tmp-*` go straight onto the board. Other channels that look like projects show up as suggestions at the bottom of the Projects column; choose **Track** or **Ignore**.
   - Settings → **Projects** lists each project's channels. You can unlink a channel or merge two projects there.
   - You can also map a project to local repos and GitHub repos to see branch and PR state on its card.

Each refresh is a Claude Code run, and it counts toward your claude.ai plan's usage. Settings shows the cost of recent refreshes.

The app finds `claude`, `git` and `gh` in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`. If you installed any of them somewhere else, symlink them into one of those folders.

## Building from source

You'll need [Node.js](https://nodejs.org) 20 or later, [pnpm](https://pnpm.io/installation), Rust through [rustup](https://rustup.rs), and the Xcode Command Line Tools (`xcode-select --install`).

```bash
git clone https://github.com/jonathantcallahan/orb-sees-all.git
cd orb-sees-all
pnpm install
pnpm test
pnpm install-app
```

`pnpm install-app` does four things:

- builds `Demian.app`;
- copies it to `/Applications`, replacing any older copy;
- quits the version that's running;
- opens the new one.

Run it again whenever you pull changes. The first build compiles the Rust side and takes a few minutes; later builds are faster.

`pnpm install-app` finds `cargo` through `rustup` even when it isn't on your PATH, which is common with Homebrew's `rustup`. Other commands such as `pnpm tauri dev` fail with `cargo metadata … No such file or directory` in that case. Add `cargo` to the current shell and rerun:

```bash
export PATH="$(dirname "$(rustup which cargo)"):$PATH"
```

To work on the app with hot reload instead, run `pnpm tauri dev`.

## Publishing a release (maintainers)

```bash
pnpm release 0.2.0
```

Before releasing, add the version's notes to `src/releaseNotes.ts`; Settings shows them under **Release notes**. `pnpm release` then runs the tests and bumps the version in `package.json`, `tauri.conf.json` and `Cargo.toml`. Then it commits, tags `v0.2.0` and pushes. The tag starts the **Release** workflow (`.github/workflows/release.yml`). On a macOS runner, the workflow builds a universal app, signs the update bundle and publishes a GitHub release. The release includes the `.dmg` and `latest.json`, which is what installed copies check. Follow the build with `gh run watch`.

Update bundles are signed with a key pair:

- The public key is in `tauri.conf.json` (`plugins.updater.pubkey`).
- The private key lives at `~/.tauri/orb.key` (password in `~/.tauri/orb.key.password`) and in the repo's Actions secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Keep a copy of the private key somewhere safe. If it's lost, installed copies can't verify new updates, and everyone has to reinstall by hand.

## Custom icon

To use your own icon without committing it, put a 1024×1024 PNG at `local/app-icon.png` (the `local/` folder is git-ignored), then run:

```bash
pnpm tauri icon local/app-icon.png --output local/icons
```

`pnpm install-app` uses `local/icons` whenever that folder exists.

## Project layout

- `src/`: the React and TypeScript app
  - `prompts.ts`: what each refresh asks Claude to do
  - `schema.ts`: the shape each refresh must return
  - `jobs/`: the refresh jobs and the job queue
  - `db.ts`: storage
- `src-tauri/`: the Rust shell
  - the allowlisted process runner for `claude`, `git` and `gh`
  - the SQLite migrations (`migrations/`)
  - the tray and the app bundle settings
- `scripts/`: the install script and the icon tools
