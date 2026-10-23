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

// Run start: open the tiers and hydrate long-term memory (warm start).
export function openMemory(opts: MemoryStoreOptions): Memory & { hydrated: number } {
  const store = new MemoryStoreService(opts);
  const hydrated = store.hydrate();
  return { store, retrieval: new MemoryRetrievalService(store), mining: new MemoryMiningService(store), hydrated };
}
