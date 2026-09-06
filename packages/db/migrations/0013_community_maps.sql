CREATE TABLE community_map_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  privacy_version integer NOT NULL,
  valid boolean NOT NULL DEFAULT true,
  graph jsonb,
  coverage jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX community_map_snapshots_window_idx ON community_map_snapshots (recipe, window_end);
--> statement-breakpoint
CREATE TABLE community_map_state (
  id text PRIMARY KEY,
  request_version integer NOT NULL DEFAULT 0,
  completed_version integer NOT NULL DEFAULT 0,
  privacy_version integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'idle',
  snapshot_id uuid REFERENCES community_map_snapshots(id),
  requested_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_success_at timestamptz,
  retry_after timestamptz,
  error text
);
--> statement-breakpoint
INSERT INTO community_map_state (id) VALUES ('current');
