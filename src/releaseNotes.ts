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
