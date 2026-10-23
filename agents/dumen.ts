// Dumen: one ticket through Intake → Executor ⇄ Verifier → (Escalation). Bounded: at most
// 1 + MAX_RETRIES executions per refund, and every step is an invariant-checked world event.
import type pg from "pg";
import type { Memory } from "../runtime/memory/index.js";
import type { Trace } from "../runtime/trace.js";
import { MAX_RETRIES, type RefundState, type World } from "../runtime/world/index.js";
import { escalate } from "./escalation.js";
import { execute } from "./executor.js";
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
}

export interface DumenResult {
  ticketId: string;
  state: RefundState;
  executions: number;
  decision: IntakeDecision | null;
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
  if (intake.outcome === "ESCALATED") await escalate(id, { world, trace, ticketMessage: ticket.message });
  if (intake.outcome !== "APPROVED") return done(intake.decision);

  // Executor ⇄ Verifier loop, bounded by MAX_RETRIES.
  for (let turn = 0; turn <= MAX_RETRIES; turn++) {
    const exec = await execute(id, { world, trace, ordersDb: deps.ordersDb, processorUrl: deps.processorUrl, callTimeoutMs: deps.callTimeoutMs });
    if (exec.state === "CONFIRMED") return done(intake.decision);

    const v = await verifyAfterUncertainCall(id, exec.callStartedAt, exec.uncertainty, verifierDeps);
    const refundKey = world.store.entity(id)!.refundKey;
    if (v.decision === "CONFIRMED") {
      await deps.ordersDb.query("UPDATE refunds SET internal_status = 'succeeded' WHERE refund_key = $1", [refundKey]);
      return done(intake.decision);
    }
    if (v.decision === "RETRY_SAME_KEY") {
      await deps.ordersDb.query("UPDATE refunds SET internal_status = 'pending' WHERE refund_key = $1", [refundKey]);
    }
    if (v.decision === "ESCALATED") {
      await escalate(id, { world, trace, ticketMessage: ticket.message });
      return done(intake.decision);
    }
    // RETRY_SAME_KEY → next turn executes again with the same refund_key
  }
  return done(intake.decision);
}
