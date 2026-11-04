import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A place on screen that holds one chat inline, instead of as a window over everything: the Detail
 * view's Updates area has one beside the briefing and inbox, so Explain and Draft response open
 * there. Opening another chat replaces the one shown. The chat stays drawn by whoever opened it,
 * portalled into `target` (see DockedChat), so it follows the current data and goes when its item
 * does; `owner` says whose it is.
 */
export interface ChatDock {
  /** Who the open chat belongs to (e.g. "reply:<id>", "explain:<key>"), or null when none is. */
  owner: string | null;
  target: HTMLElement | null;
  open(owner: string): void;
  /** Closes the chat, if it's still this owner's. */
  close(owner: string): void;
}

const DockContext = createContext<ChatDock | null>(null);
/** True inside the dock: a chat there draws inline, not as a window. */
const InDockContext = createContext(false);

export const ChatDockProvider = DockContext.Provider;

/** The dock to open chats in, or null where chats open as windows. */
export function useChatDock(): ChatDock | null {
  return useContext(DockContext);
}

export function useInDock(): boolean {
  return useContext(InDockContext);
}

/** Draws a chat into the dock while `owner` holds it, and gives the dock back if this goes away first. */
export function DockedChat({ dock, owner, children }: { dock: ChatDock; owner: string; children: ReactNode }) {
  const close = useRef(dock.close);
  close.current = dock.close;
  useEffect(() => () => close.current(owner), [owner]);
  if (dock.owner !== owner || !dock.target) return null;
  return createPortal(<InDock>{children}</InDock>, dock.target);
}

/** Wraps the dock's content, so the chat in it knows to draw inline. */
export function InDock({ children }: { children: ReactNode }) {
  return <InDockContext.Provider value={true}>{children}</InDockContext.Provider>;
}

/**
 * The Detail view's Tasks area holds one task's chat in place of All tasks. The chat stays drawn by
 * its task card (so it keeps following the session), portalled into `target`; `owner` says whose
 * it is, so the card that takes it over (when opening it moves the task into Today, its new card
 * there) knows to show it, and the card that had it lets go.
 */
export interface TaskChatDock {
  /** The task whose chat is open, and which chat (TaskCard's chatFor). */
  owner: { id: string; kind: number } | null;
  /** Where the chat draws; null until the pane is on screen. */
  target: HTMLElement | null;
  open(id: string, kind: number): void;
  /** Closes it, if it's still this task's. */
  close(id: string): void;
}

const TaskDockContext = createContext<TaskChatDock | null>(null);
export const TaskChatDockProvider = TaskDockContext.Provider;

/** The Tasks area's chat dock, or null where task chats open as windows. */
export function useTaskChatDock(): TaskChatDock | null {
  return useContext(TaskDockContext);
}
