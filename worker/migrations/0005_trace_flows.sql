-- Phase 5: multipath (ECMP). Group hops into flows (distinct load-balanced
-- paths). flow_id 0 = single-path (default for all pre-existing traces and any
-- non-multipath trace).
ALTER TABLE trace_hops ADD COLUMN flow_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_trace_hops_flow ON trace_hops(trace_id, flow_id, ttl);
