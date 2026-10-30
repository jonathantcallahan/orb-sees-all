# Orb Sees All

A macOS desktop app that pulls your day together from Slack, Gmail, Google Calendar, Google Drive and Jira. Each project gets a status, blockers and your tasks. It also keeps a task list built from DMs, mentions and email, plus today's meetings with prep. Every weekday morning it refreshes itself.

The app has no API keys or OAuth apps of its own. It runs [Claude Code](https://docs.claude.com/en/docs/claude-code) headless (`claude -p`) and uses the connectors on your claude.ai account. Those jobs can only read. The one exception is Slack: the app posts a message there only after you write it and click **Send**.

Everything the app stores stays on your machine. It's a SQLite database in `~/Library/Application Support/com.orb.app/`.

## Requirements

- A Mac (Apple silicon or Intel)
- [Claude Code](https://docs.claude.com/en/docs/claude-code/setup), signed in with a claude.ai account (Pro, Max, Team or Enterprise)
- Optional: the [GitHub CLI](https://cli.github.com) (`gh`), signed in, if you want PR status on project cards

## 1. Connect your accounts in claude.ai

The app relies on claude.ai's connectors, which Claude Code can use once you sign in with that account. In [claude.ai](https://claude.ai) → **Settings → Connectors**, connect:

| Connector | Used for | Needed? |
| --- | --- | --- |
| Slack | Projects, tasks, replies, news | Yes |
| Gmail | Email tasks and replies | Yes |
| Google Calendar | Today's meetings and prep | Yes |
| Google Drive | Research when planning a task | Optional |
| Your company's knowledge-base connector | Company context when planning | Optional |

Jira is read through a local MCP server named `mcp-jira`. It's optional; without it, Claude simply has no Jira tools. To add it, configure an MCP server with that name in Claude Code (`claude mcp add mcp-jira …`), using whatever Jira MCP server your company uses.

Check that headless Claude Code can see the connectors:

```bash
claude -p "List the Slack, Gmail and Google Calendar tools you have. Just their names."
```

If that reports no tools, run `claude` interactively, use `/login` to sign in with your claude.ai account, and try again.

**If you route Claude Code through a gateway** (`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`): the app clears both for its own runs. A gateway login replaces the claude.ai login, and that turns off the connectors. You still need to be signed in to claude.ai too.

## 2. Install

1. Download `Orb.Sees.All_<version>_universal.dmg` from the [latest release](https://github.com/jonathantcallahan/orb-sees-all/releases/latest).
2. Open the `.dmg` and drag **Orb Sees All** into **Applications**.
3. The app isn't signed by Apple yet, so the first time, **right-click it in Applications and choose Open**, then **Open** again in the dialog. After that it opens normally. If macOS says the app "is damaged", run this once and open it again:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Orb Sees All.app"
   ```

**Updates:** the app checks GitHub for a new version at launch and every few hours. When one is out, an **Update to x.y.z** button appears in the header. Click it, and the app downloads the update and restarts.

## 3. First run

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

- builds `Orb Sees All.app`;
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

That runs the tests and bumps the version in `package.json`, `tauri.conf.json` and `Cargo.toml`. Then it commits, tags `v0.2.0` and pushes. The tag starts the **Release** workflow (`.github/workflows/release.yml`). On a macOS runner, the workflow builds a universal app, signs the update bundle and publishes a GitHub release. The release includes the `.dmg` and `latest.json`, which is what installed copies check. Follow the build with `gh run watch`.

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
