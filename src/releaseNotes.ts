/**
 * What changed in each version, newest first, for Settings > Release notes. Add an entry here with
 * each release (`pnpm release` publishes whatever is committed).
 */
export interface ReleaseNote {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  notes: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: "0.6.12",
    date: "2026-11-05",
    notes: [
      "The daily briefing is a short update in a few paragraphs, like a staffer catching you between meetings: what moved on your key projects, the tasks only you can move, and new messages from the people who matter.",
      "Demian reads your Granola meeting notes for project updates and watched topics, once Granola is connected.",
      "Task chats: while Claude works, Stop takes the send button's place and what it's doing shows in the reply box. Opening a chat no longer starts anything; your first message does. Edits to a drafted message, doc, event or ticket are kept until you send it, even if you close the chat or quit. Messages drafted as a DM to someone now send.",
      "Task cards: a task Claude is working on says Working. The plan stays open, with a spinner beside its heading while it's written, and its steps are short enough for one line. Task investigation sits under the plan, starts folded and gives its verdict in gray. Every task has Double check, and links sit under a line at the bottom.",
      "Claude's runs in Demian can only use what each one needs, and never post, send or change anything unless that's its job. A run that stalls or runs too long stops on its own, and quitting Demian stops them all.",
      "Setup has Check again on the install and sign-in steps, goes straight on once your tools are connected, and on Windows adds Claude Code to your PATH when its installer leaves it off.",
      "Softer calendar event borders, and no tooltips on task titles, Blocking badges or spinners.",
      "Fixes: badges cut off at the bottom, the task spinner sitting off-center, and the updated time showing in larger text.",
    ],
  },
  {
    version: "0.6.11",
    date: "2026-11-05",
    notes: [
      "Every task has Open in chat, planned or not, all yours or not. The chat talks the plan through with you before it starts; on a task with no plan yet it asks whether you'd like one.",
      "Plan steps follow the chat and keep their states when the plan is restated, and a task is done only when every step is.",
      "A task's chat can rename the task, change its description or move it to another project, as cards you apply. Chats also hand Jira tickets to Demian to review and file, and ask for the code folders they need.",
      "The Demian chat trusts the task you mean, and can rename, re-plan and move tasks.",
      "Task cards are simpler: the full description, the Plan box with Open in chat, Links and Open in Claude under it, Double check as ↻ in the header, and the time estimate always first. The task whose chat is open is outlined.",
      "Merged notes have Undo merge and a button to hide them. Project details stay gray until you hover them.",
      "Fixes: the focus ring staying on priority and status badges after picking from them with the mouse.",
    ],
  },
  {
    version: "0.6.10",
    date: "2026-11-04",
    notes: [
      "Watched topics, in a tab of their own: tell Demian what to keep an eye on, and what to do if something happens or doesn't happen by a date. It checks each topic every refresh, keeps a list of updates with their sources, and offers Create and open task when an action is ready. Discuss a topic to change its actions, or hover it and click ↻ to check just that one.",
      "Messages you send yourself in Slack with #demian can do anything the Demian chat can: add a task, watch a topic, create or change a project, add context to a project or task. Demian replies in the message's thread with what it did. It's off until you turn it on in Settings, and checks every 5 minutes.",
      "Tasks that are the same work are merged into one, after each refresh and when you add a task. A merged task says what was merged into it, and Separate undoes it.",
      "Task titles stay short, with the detail in the description; long titles you wrote are shortened once, keeping your text as the brief.",
      "A blocked step marks its task blocked. Meeting prep is its own source in the task filters. Times show only for today; earlier days show just the day.",
      "Settings explains each option in a tooltip.",
      "Fixes: the bottom border of calendar events, and the calendar scrolling away from now early in the morning.",
    ],
  },
  {
    version: "0.6.9",
    date: "2026-11-03",
    notes: [
      "Plan steps show in full, and your own steps have an orange circle.",
      "A Draft response chat that's also a task now follows the task's steps and ticks them off.",
      "The Demian chat can add a task straight into Today, with its status and priority.",
      "Priority badges look the same weight until you hover a card.",
      "Fixes: All tasks coming back after a task finishes in its chat, and the Demian chat missing tasks you just added.",
    ],
  },
  {
    version: "0.6.8",
    date: "2026-11-03",
    notes: ["Settings shows everything Demian has learned in one list: what you told the chat and the lessons from your corrections."],
  },
  {
    version: "0.6.7",
    date: "2026-11-03",
    notes: [
      "A simpler layout: the detail view is the only view, with the calendar's times in the rail, a calendar that scrolls on its own and drifts back to now, and Ephedra as the default orb.",
      "Setup walks you through every step, with one-click and copy-paste options for installing Claude Code, signing in and connecting tools, and notices on its own when each is done.",
      "Tasks you type as a detailed note get a short title, with your note kept for planning. Time estimates count only your own hands-on time.",
      "A task's chat opens beside it in place of All tasks. Tasks that need you show a Human status, and Open in chat is always there.",
      "The Demian chat can set a project's status, mark or double check its items and unlink channels. Applied learnings move to Settings.",
      "Claude can read Zoom meetings and Amplitude.",
      "Ask why after a change can be dismissed, asked less often, or set in Settings.",
      "Ephedra ripples when you finish a task. Everything loading shows its steps at the bottom of the window.",
      "Fixes: lost task notes, chat panes left blank, double-created tasks, group DMs shown as channels and duplicated decisions.",
    ],
  },
  {
    version: "0.6.6",
    date: "2026-11-02",
    notes: [
      "Talking with Claude about a task shows the plan's steps beside the chat, with links to what each step sent or created, and stays open until you close it.",
      "Claude can read your code (your own clones, found automatically, or the project's GitHub repos), Claude Docs, and Google Docs, Sheets and Slides.",
      "Claude can create Google Docs and calendar invites for you to review, finding a time that's free for everyone invited.",
      "Claude looks things up before asking people, checks what it's told before agreeing, and has good habits for plans and messages built in.",
      "Epics in Project details open to show their issues and who each is assigned to.",
      "A task marks itself done when its last step is done, and All tasks stays sorted by priority.",
      "Three new orbs: Penelope (frosted glass with soft color), Edith (an opal sealed in cut glass) and Ephedra (an aura). Roth and Ophelia are set aside for now.",
      "Fixes: the chat's cursor and message order, stuck Thinking and blank chats, folder-access prompts on every launch, and messages that now say which channel or DM they go to.",
    ],
  },
  {
    version: "0.6.5",
    date: "2026-11-02",
    notes: [
      "Project context: how Demian understands each project, as entries you can reword, remove and add to. Open it from Project details.",
      "Ask the chat about your tasks: it finds them and can move one into Today's tasks, mark it done or set its priority.",
      "⌘N jumps to Add a task; ⌘D opens the chat.",
      "Demian keeps its picture of your role up to date in the background.",
    ],
  },
  {
    version: "0.6.4",
    date: "2026-11-02",
    notes: [
      "Meeting prep shows up as tasks in Today's tasks.",
      "Active work on a project can be double checked and marked done, like blockers.",
      "Calendar polish: even spacing, and finer lines for maybe meetings.",
    ],
  },
  {
    version: "0.6.3",
    date: "2026-11-02",
    notes: ["Fixes setup and refreshes missing Slack, Gmail and Calendar with the latest Claude Code."],
  },
  {
    version: "0.6.2",
    date: "2026-11-02",
    notes: ["Onboarding walks you through installing Claude Code, signing in and connecting your tools."],
  },
  {
    version: "0.6.0",
    date: "2026-11-02",
    notes: [
      "Demian learns from your corrections: what you change, and why, shapes later refreshes, plans and messages.",
      "The Demian chat, for fixing what Demian has wrong or missing.",
      "Meeting prep lives in each meeting's card on the calendar.",
      "Windows fixes.",
    ],
  },
  {
    version: "0.5.0",
    date: "2026-10-31",
    notes: ["A new onboarding that sets you up and learns your role."],
  },
];
