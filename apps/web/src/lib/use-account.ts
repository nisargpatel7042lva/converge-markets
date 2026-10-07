"use client";
import { useSyncExternalStore } from "react";
import { loadProfile, subscribeProfile, type Profile } from "./account";
import { handleOf } from "./handle";

const server = () => null;
const noop = () => () => {};
const yes = () => true;
const no = () => false;

/** The signed-in account (or null), with its friendly handle. Re-renders on create, restore, forget. */
export function useAccount(): { profile: Profile | null; handle: string | null; ready: boolean } {
  const profile = useSyncExternalStore(subscribeProfile, loadProfile, server);
  // `ready` is false during server rendering and the first client render (no flash of "signed out")
  const ready = useSyncExternalStore(noop, yes, no);
  return { profile, handle: profile ? handleOf(profile.address) : null, ready };
}
