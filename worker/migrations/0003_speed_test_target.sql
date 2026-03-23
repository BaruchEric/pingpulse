-- Add target column to speed_tests: "worker" (our CF Worker) or "edge" (nearest CF PoP)
ALTER TABLE speed_tests ADD COLUMN target TEXT NOT NULL DEFAULT 'worker' CHECK (target IN ('worker', 'edge'));
