"use client";
import { useQuery } from "@tanstack/react-query";
import { epochsOf } from "./activity";
import { nowSec as clockNow, syncClock } from "./clock";
import type { Address } from "viem";
import { deployment } from "@/config/deployment";
import {
  indexerClient,
  readAllRounds,
  readBalances,
  readHoldings,
  readLadder,
  readRound,
  type Round,
} from "./data";

/** One clock for countdowns, ticking every second. */
import { createContext, useContext, useEffect, useState } from "react";
/** The time the server rendered with: the first client render uses it too, so hydration matches. */
export const NowSeed = createContext<number | undefined>(undefined);

export function useNow(): number {
  const seed = useContext(NowSeed);
  const [n, setN] = useState(() => seed ?? clockNow());
  useEffect(() => {
    setN(clockNow());
    const t = setInterval(() => setN(clockNow()), 1000);
    return () => clearInterval(t);
  }, []);
  return n;
}

/** Keeps the chain-time offset fresh (mounted once, in the providers). */
export function useClockSync() {
  useEffect(() => {
    void syncClock();
    const t = setInterval(() => void syncClock(), 8000);
    return () => clearInterval(t);
  }, []);
}

export function useRounds(initial?: Round[]) {
  return useQuery({
    queryKey: ["rounds", deployment.vault],
    queryFn: async () => {
      // the clock sync runs beside the reads, not before them: one round trip less before the first paint of data
      const [, rounds] = await Promise.all([syncClock(), readAllRounds(clockNow())]);
      return rounds;
    },
    refetchInterval: 5000,
    staleTime: 2000,
    ...(initial ? { initialData: initial, initialDataUpdatedAt: Date.now() } : {}),
  });
}

export function useRound(address: Address | undefined) {
  return useQuery({
    queryKey: ["round", address],
    queryFn: () => readRound(address as Address),
    enabled: Boolean(address),
    refetchInterval: 4000,
  });
}

export function useLadder(round: Round | null | undefined, spot: number | null) {
  const live = round?.state === 1 && spot !== null;
  return useQuery({
    queryKey: ["ladder", round?.address, spot === null ? null : Math.round(spot)],
    queryFn: () => readLadder(round!.address, spot!, clockNow()),
    enabled: Boolean(live),
    refetchInterval: 2500,
    staleTime: 1000,
    retry: 1,
  });
}

export function useBalances(user: Address | undefined) {
  return useQuery({
    queryKey: ["balances", user],
    queryFn: () => readBalances(user as Address),
    enabled: Boolean(user),
    refetchInterval: 4000,
  });
}

export function useHoldings(user: Address | undefined, rounds: Round[] | undefined) {
  return useQuery({
    queryKey: ["holdings", user, rounds?.map((r) => r.address).join(",")],
    queryFn: () => readHoldings(user as Address, rounds as Round[]),
    enabled: Boolean(user && rounds),
    refetchInterval: 5000,
  });
}

export function useVault(user: Address | undefined) {
  return useQuery({
    queryKey: ["vault", user],
    queryFn: async () => (await import("./data-vault")).readVault(user, user ? epochsOf(user) : []),
    refetchInterval: 5000,
  });
}

/** Everything from the indexer is optional: the app works with the chain alone. */
export function useIndexerVault() {
  return useQuery({
    queryKey: ["ix-vault"],
    queryFn: async () => {
      const c = indexerClient();
      if (!c) return null;
      const [v, nav] = await Promise.all([
        c.vault(),
        c.navHistory(Math.floor(Date.now() / 1000) - 30 * 86400, 400),
      ]);
      return { ...v, nav };
    },
    refetchInterval: 15000,
    retry: 1,
  });
}

export function useIndexerStats() {
  return useQuery({
    queryKey: ["ix-stats"],
    queryFn: async () => {
      const c = indexerClient();
      if (!c) return null;
      const [protocol, daily, v, status] = await Promise.all([
        c.protocolStats(),
        c.dailyStats(30),
        c.vault(),
        c.status(),
      ]);
      return { protocol, daily, vault: v.vault, status };
    },
    refetchInterval: 20000,
    retry: 1,
  });
}

/** The executor reward the venue asks for now (it can be changed by the owner after the build). */
export function useMinReward() {
  return useQuery({
    queryKey: ["min-reward"],
    queryFn: async () => {
      const { forwardVenueAbi } = await import("@converge/sdk");
      const { publicClient } = await import("./chain");
      const { deployment } = await import("@/config/deployment");
      return publicClient.readContract({
        address: deployment.venue,
        abi: forwardVenueAbi,
        functionName: "minReward",
      });
    },
    staleTime: 60_000,
  });
}

/** The public status line (see lib/status.ts): the app server aggregates it so every client sees the same one. */
export function useStatus() {
  return useQuery({
    queryKey: ["status"],
    queryFn: async () => {
      const res = await fetch("/api/status", { cache: "no-store" });
      // a 503 still carries the body ("down"); anything else that is not JSON is an error
      return (await res.json()) as import("./status").Status;
    },
    refetchInterval: 15000,
    retry: 1,
  });
}
