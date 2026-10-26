// Dumen: one ticket through Intake → Executor ⇄ Verifier → (Escalation). Bounded: at most
// 1 + MAX_RETRIES executions per refund, and every step is an invariant-checked world event.
import type pg from "pg";
import type { Memory } from "../runtime/memory/index.js";
import type { Trace } from "../runtime/trace.js";
import { MAX_RETRIES, type RefundState, type World } from "../runtime/world/index.js";
import { escalate } from "./escalation.js";
import { execute, executePayoutBatch } from "./executor.js";
import { runIntake, type IntakeDecision, type Ticket } from "./intake.js";
import { verifyAfterUncertainCall, type VerifierDeps } from "./verifier.js";

export interface DumenDeps {
  world: World;
  memory: Memory;
  trace: Trace;
  ordersDb: pg.Pool;
  processorUrl: string;
  callTimeoutMs: number;
  verifier: Omit<VerifierDeps, "world" | "memory" | "trace">;
  cachedIntake?: Record<string, IntakeDecision>;
  modelSummaries?: boolean; // false: escalation uses the template summary (cached / benchmark runs)
  deferSummaries?: boolean; // true: template now, model summary in finishSummaries() at run end
  onVerify?: (entityId: string) => void; // progress: an uncertain call is being verified
}

export interface DumenResult {
  ticketId: string;
  state: RefundState;
  executions: number;
  decision: IntakeDecision | null;
}

// Executor ⇄ Verifier until the refund settles: CONFIRMED, or ESCALATED (with a case in
// the queue). Starts from APPROVED or RETRY_SAME_KEY; the world enforces the retry budget.
export async function executeUntilSettled(entityId: string, ticketMessage: string, deps: DumenDeps): Promise<RefundState> {
  const { world, memory, trace } = deps;
  const verifierDeps: VerifierDeps = { world, memory, trace, ...deps.verifier };
  for (let turn = 0; turn <= MAX_RETRIES + world.store.entity(entityId)!.humanApprovals; turn++) {
    const e = world.store.entity(entityId)!;
    const execDeps = { world, trace, ordersDb: deps.ordersDb, processorUrl: deps.processorUrl, callTimeoutMs: deps.callTimeoutMs };
    // A single payout (e.g. after a person approved it) goes out as a batch of one.
    const exec = e.kind === "payout" ? (await executePayoutBatch([entityId], e.batchId ?? "approved", execDeps))[0] : await execute(entityId, execDeps);
    if (exec.state === "CONFIRMED") return "CONFIRMED";

    deps.onVerify?.(entityId);
    const v = await verifyAfterUncertainCall(entityId, exec.callStartedAt, exec.uncertainty ?? "timeout", verifierDeps);
    const refundKey = e.refundKey;
    const table = e.kind === "payout" ? "payouts" : "refunds";
    const keyCol = e.kind === "payout" ? "payout_key" : "refund_key";
    if (v.decision === "CONFIRMED") {
      await deps.ordersDb.query(`UPDATE ${table} SET internal_status = 'succeeded' WHERE ${keyCol} = $1`, [refundKey]);
      return "CONFIRMED";
    }
    if (v.decision === "ESCALATED") {
      await escalate(entityId, { world, trace, ticketMessage, useModel: deps.modelSummaries, deferModel: deps.deferSummaries });
      return "ESCALATED";
    }
    // RETRY_SAME_KEY → next turn executes again with the same refund_key
    await deps.ordersDb.query(`UPDATE ${table} SET internal_status = 'pending' WHERE ${keyCol} = $1`, [refundKey]);
  }
  return world.store.entity(entityId)!.state;
}

export async function runDumen(ticket: Ticket, deps: DumenDeps): Promise<DumenResult> {
  const { world, memory, trace } = deps;
  const verifierDeps: VerifierDeps = { world, memory, trace, ...deps.verifier };

  const { entity } = await world.ingest.receive(ticket, { agentId: "dumen", taskId: ticket.ticket_id });
  const id = entity.id;
  const done = (decision: IntakeDecision | null): DumenResult => {
    const e = world.store.entity(id)!;
    return { ticketId: ticket.ticket_id, state: e.state, executions: e.executions, decision };
  };

  const { rows } = await deps.ordersDb.query("SELECT amount, currency FROM orders WHERE order_id = $1", [ticket.order_id]);
  if (!rows[0]) {
    await world.ingest.transition(id, "INTAKE_REVIEW", { agentId: "dumen", taskId: ticket.ticket_id }, { provenance: { source: "ticket" } });
    await world.ingest.transition(id, "REJECTED", { agentId: "dumen", taskId: ticket.ticket_id }, { provenance: { source: "ticket" }, reason: "order not found" });
    return done(null);
  }

  const intake = await runIntake(ticket, id, {
    world,
    memory,
    trace,
    verifier: verifierDeps,
    order: { amount: Number(rows[0].amount), currency: rows[0].currency },
    cached: deps.cachedIntake?.[ticket.ticket_id],
  });
  if (intake.outcome === "ESCALATED") await escalate(id, { world, trace, ticketMessage: ticket.message, useModel: deps.modelSummaries, deferModel: deps.deferSummaries });
  if (intake.outcome !== "APPROVED") return done(intake.decision);

  await executeUntilSettled(id, ticket.message, deps);
  return done(intake.decision);
}
