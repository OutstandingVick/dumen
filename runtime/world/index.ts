// Meterless World Model Agent Engine, mounted for Dumen.
import { ContextBuilderService } from "./context.js";
import { IngestPipelineService } from "./ingest.js";
import { WorldStoreService } from "./store.js";

export * from "./types.js";
export { payoutEntityId, refundEntityId, refundKeyFor, stableHash } from "./ids.js";
export { HUMAN_AGENT, InvariantViolation, MAX_RETRIES } from "./machine.js";
export { ContextBuilderService, type RefundContext } from "./context.js";
export { IngestPipelineService, PIPELINE_MANIFEST, type Actor, type IngestResult } from "./ingest.js";
export { WorldStoreService, reduceEntity } from "./store.js";

export interface World {
  store: WorldStoreService;
  ingest: IngestPipelineService;
  context: ContextBuilderService;
}

export function openWorld(runId: string, dir?: string): World {
  const store = new WorldStoreService(runId, dir);
  return { store, ingest: new IngestPipelineService(store), context: new ContextBuilderService(store) };
}
