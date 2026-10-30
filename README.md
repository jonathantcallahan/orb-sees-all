# Orb Sees All

A macOS desktop app that pulls your day together from Slack, Gmail, Google Calendar, Google Drive and Jira. Each project gets a status, blockers and your tasks. It also keeps a task list built from DMs, mentions and email, plus today's meetings with prep. Every weekday morning it refreshes itself.

The app has no API keys or OAuth apps of its own. It runs [Claude Code](https://docs.claude.com/en/docs/claude-code) headless (`claude -p`) and uses the connectors on your claude.ai account. Those jobs can only read. The one exception is Slack: the app posts a message there only after you write it and click **Send**.

Everything the app stores stays on your machine. It's a SQLite database in `~/Library/Application Support/com.jcallahan.dayplanner/`.

## Requirements

- macOS on Apple silicon (Intel should work but hasn't been tried)
- [Node.js](https://nodejs.org) 20 or later, and [pnpm](https://pnpm.io/installation)
- Rust, through [rustup](https://rustup.rs)
- Xcode Command Line Tools: `xcode-select --install`
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

## 2. Build and install

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

If the build fails with `cargo metadata … No such file or directory`, your shell can't find `cargo`. This happens with Homebrew's `rustup`, which doesn't put `cargo` on your PATH. Add it for the current shell and rerun:

```bash
export PATH="$(dirname "$(rustup which cargo)"):$PATH"
```

To work on the app with hot reload instead, run `pnpm tauri dev`.

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
