"use client";
import { useSyncExternalStore } from "react";

/**
 * In a restricted region the app stays open for getting your money out (collect, withdraw, export)
 * and closes for new bets and deposits. The edge middleware sets this cookie; the UI reads it. It
 * is a UI mode, not an access control: the contracts are open to anyone.
 */
const read = () => typeof document !== "undefined" && /(?:^|;\s*)exit_only=1/.test(document.cookie);
const noop = () => () => {};
export function useExitOnly(): boolean {
  return useSyncExternalStore(noop, read, () => false);
}
