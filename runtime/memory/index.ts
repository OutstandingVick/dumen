// Meterless H-MEM Agent Engine, mounted for Dumen.
import { MemoryMiningService } from "./mining.js";
import { MemoryRetrievalService } from "./retrieval.js";
import { MemoryStoreService, type MemoryStoreOptions } from "./store.js";

export * from "./types.js";
export { MemoryStoreService, memoryId } from "./store.js";
export { MemoryRetrievalService, waitWindowFrom, type RetrievalQuery } from "./retrieval.js";
export { MemoryMiningService, PROMOTION_POLICY, type VerificationOutcome } from "./mining.js";
export { TrustLedgerService } from "./ledger.js";

export interface Memory {
  store: MemoryStoreService;
  retrieval: MemoryRetrievalService;
  mining: MemoryMiningService;
}

// Run start: open the tiers and hydrate long-term memory (warm start). fresh: skip the
// warm start so a run depends on nothing saved by earlier runs (reproducible benchmarks).
export function openMemory(opts: MemoryStoreOptions & { fresh?: boolean }): Memory & { hydrated: number } {
  const store = new MemoryStoreService(opts);
  const hydrated = opts.fresh ? 0 : store.hydrate();
  return { store, retrieval: new MemoryRetrievalService(store), mining: new MemoryMiningService(store), hydrated };
}
