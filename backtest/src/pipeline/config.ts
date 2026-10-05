/**
 * Experiment definitions. The pessimistic scenario and the verdict rule were fixed before any
 * hold-out result was read; the sniper scenario and the forward-priced design were added after
 * exploring training-window results (see the report's Method section).
 */
import type { StrategyParams } from "@converge/strategy";
import { BASE_FLOW, PESSIMISTIC_FLOW } from "../scenarios";
import type { FlowConfig, VenueConfig } from "../types";

export const NAV0 = 5000; // CLAUDE.md launch TVL cap

/** Taker flow scenarios. */
export const SCENARIOS: Record<string, { label: string; flow: FlowConfig }> = {
  base: { label: "Base", flow: BASE_FLOW },
  pessimistic: { label: "Pessimistic (spec)", flow: PESSIMISTIC_FLOW },
  sniper: {
    label: "Sniper, 1 s lead",
    flow: { ...BASE_FLOW, informedMode: "sniper", sniperPresence: 1, latencyMs: 1000 },
  },
  sniperPessimistic: {
    label: "Sniper, 2 s lead, thin flow",
    flow: { ...PESSIMISTIC_FLOW, informedMode: "sniper", sniperPresence: 1, latencyMs: 2000 },
  },
};

/** The two venue designs under test. */
export const DESIGNS: Record<string, { label: string; venue: Partial<VenueConfig> }> = {
  specified: {
    label: "As specified (ADR-001 Option D: keeper-posted quotes, immediate fills)",
    venue: { quoteMode: "posted", execDelayBlocks: 0 },
  },
  proposed: {
    label: "Proposed (forward-priced execution, 5 blocks = 2 s)",
    venue: { quoteMode: "swapTime", execDelayBlocks: 5 },
  },
};

/** Verdict thresholds (see the report's Method section). */
export const VERDICT_RULE = {
  /** The scenarios the verdict is the worst case over. */
  scenarios: ["pessimistic", "sniper"] as const,
};

export type Quick = {
  trainStride: number;
  /** Day stride of the finalist confirmation runs on the training window (1 = all 60 days). */
  finalStride: number;
  holdStride: number;
  sweepStride: number;
  screenN: number;
  topK: number;
};
export const FULL: Quick = {
  trainStride: 6,
  finalStride: 1,
  holdStride: 1,
  sweepStride: 6,
  screenN: 96,
  topK: 6,
};
export const QUICK: Quick = {
  trainStride: 20,
  finalStride: 15,
  holdStride: 15,
  sweepStride: 30,
  screenN: 6,
  topK: 2,
};

export type ParamSet = { name: string; params: StrategyParams };
