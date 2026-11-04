-- Range expansion overestimates small batches and triggers expensive JIT
-- compilation on every temporary-table plan. Interpretation is faster here.
ALTER FUNCTION rollup_expired_membership(timestamptz) SET jit=off;
