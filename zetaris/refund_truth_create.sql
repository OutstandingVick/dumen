-- Dumen semantic layer in Zetaris. One statement per block; run in order.
-- The Postgres logins are the local, synthetic ones from docker-compose.yml.
-- Zetaris runs in Docker, so it reaches the Dumen databases via host.docker.internal.

-- 1. Source A: orders DB (orders, refunds)
CREATE DATASOURCE dumen_orders DESCRIBE BY "dumen_orders_source_a" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://host.docker.internal:5433/orders",
  username "dumen",
  password "dumen"
);

-- 2.
REGISTER DATASOURCE TABLES ('orders', 'refunds') FROM dumen_orders;

-- 3. Source B: processor log
CREATE DATASOURCE dumen_processor DESCRIBE BY "dumen_processor_source_b" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://host.docker.internal:5434/processor",
  username "dumen",
  password "dumen"
);

-- 4.
REGISTER DATASOURCE TABLE 'processor_log' FROM dumen_processor;

-- 5. Folder for the view
CREATE SCHEMASTORE CONTAINER dumen;

-- 6. refund_truth: one row per refund_key.
--   paid      = the processor paid it exactly once (whatever we recorded)
--   not_paid  = the processor never paid it, and we don't claim it was paid
--   conflict  = paid more than once (double refund), or we say paid but the processor has no success
CREATE OR REPLACE SCHEMASTORE VIEW refund_truth WITH CONTAINER dumen AS
SELECT
  COALESCE(r.refund_key, p.refund_key)   AS refund_key,
  r.order_id,
  COALESCE(r.amount, p.paid_amount)      AS amount,
  r.internal_status,
  p.processor_status,
  COALESCE(p.success_count, 0)           AS success_count,
  COALESCE(p.paid_amount, 0)             AS paid_amount,
  CASE
    WHEN COALESCE(p.success_count, 0) > 1 THEN 'conflict'
    WHEN COALESCE(p.success_count, 0) = 1 THEN 'paid'
    WHEN r.internal_status = 'succeeded'  THEN 'conflict'
    ELSE 'not_paid'
  END                                    AS truth
FROM dumen_orders.refunds r
FULL OUTER JOIN (
  SELECT
    refund_key,
    SUM(CASE WHEN processor_status = 'succeeded' THEN 1 ELSE 0 END)      AS success_count,
    SUM(CASE WHEN processor_status = 'succeeded' THEN amount ELSE 0 END) AS paid_amount,
    CASE WHEN SUM(CASE WHEN processor_status = 'succeeded' THEN 1 ELSE 0 END) > 0
         THEN 'succeeded' ELSE 'failed' END                               AS processor_status
  FROM dumen_processor.processor_log
  GROUP BY refund_key
) p ON r.refund_key = p.refund_key;
