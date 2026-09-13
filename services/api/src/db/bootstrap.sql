-- =============================================================================
-- Peapod domain schema -- idempotent bootstrap
-- =============================================================================
--
-- PURPOSE
--   Create every table the API owns, plus the indexes the row-level policy
--   helpers and the scheduled jobs filter on. Safe to re-run: every statement
--   is CREATE IF NOT EXISTS. This is the "just make the database look right"
--   path used by `ensureSchema()` when no drizzle-kit migration folder is
--   present, which is the common local-dev case.
--
-- WHY GEN_RANDOM_UUID()
--   Postgres 13+ ships `gen_random_uuid()` in core. We rely on it so inserts
--   that omit `id` still get a primary key without a pgcrypto dance.
--
-- OWNERSHIP
--   Credential tables (auth_credentials, refresh_tokens, otp_codes, ...) are
--   NOT here. The security service migrates those itself. Do not add them.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Core
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  permissions_granted BOOLEAN NOT NULL DEFAULT false,
  role TEXT NOT NULL DEFAULT 'user'
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);

CREATE TABLE IF NOT EXISTS pods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '❤️',
  group_type TEXT NOT NULL DEFAULT 'couple',
  trip_history_enabled BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS pods_created_by_id_idx ON pods (created_by_id);

CREATE TABLE IF NOT EXISTS pod_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  pod_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role TEXT NOT NULL DEFAULT 'member'
);
CREATE UNIQUE INDEX IF NOT EXISTS pod_memberships_pod_user_idx ON pod_memberships (pod_id, user_id);
CREATE INDEX IF NOT EXISTS pod_memberships_pod_id_idx ON pod_memberships (pod_id);
CREATE INDEX IF NOT EXISTS pod_memberships_user_id_idx ON pod_memberships (user_id);

CREATE TABLE IF NOT EXISTS pod_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  pod_id UUID NOT NULL,
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pod_invites_code_idx ON pod_invites (code);
CREATE INDEX IF NOT EXISTS pod_invites_pod_id_idx ON pod_invites (pod_id);

CREATE TABLE IF NOT EXISTS location_pings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  speed DOUBLE PRECISION NOT NULL DEFAULT 0,
  accuracy DOUBLE PRECISION NOT NULL DEFAULT 0,
  heading DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_driving BOOLEAN NOT NULL DEFAULT false,
  pod_id UUID
);
CREATE INDEX IF NOT EXISTS location_pings_pod_id_idx ON location_pings (pod_id);
CREATE INDEX IF NOT EXISTS location_pings_created_by_id_idx ON location_pings (created_by_id);
CREATE INDEX IF NOT EXISTS location_pings_created_at_idx ON location_pings (created_at);

CREATE TABLE IF NOT EXISTS phone_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  battery_level INTEGER NOT NULL DEFAULT 0,
  is_charging BOOLEAN NOT NULL DEFAULT false,
  connection_type TEXT NOT NULL DEFAULT 'unknown',
  signal_bars INTEGER NOT NULL DEFAULT 0,
  battery_supported BOOLEAN NOT NULL DEFAULT true,
  connection_supported BOOLEAN NOT NULL DEFAULT true,
  pod_id UUID
);
CREATE INDEX IF NOT EXISTS phone_statuses_pod_id_idx ON phone_statuses (pod_id);
CREATE INDEX IF NOT EXISTS phone_statuses_created_by_id_idx ON phone_statuses (created_by_id);

CREATE TABLE IF NOT EXISTS favourite_places (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  expires_at TIMESTAMPTZ,
  pod_id UUID
);
CREATE INDEX IF NOT EXISTS favourite_places_pod_id_idx ON favourite_places (pod_id);

CREATE TABLE IF NOT EXISTS place_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  place_name TEXT NOT NULL,
  event TEXT NOT NULL,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  pod_id UUID
);
CREATE INDEX IF NOT EXISTS place_alerts_pod_id_idx ON place_alerts (pod_id);

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  location_name TEXT,
  for_whom TEXT NOT NULL DEFAULT 'pod',
  participant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  repeat_frequency TEXT NOT NULL DEFAULT 'none',
  pod_id UUID
);
CREATE INDEX IF NOT EXISTS plans_pod_id_idx ON plans (pod_id);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  recipient_id UUID,
  pod_id UUID,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_pod_id_idx ON messages (pod_id);
CREATE INDEX IF NOT EXISTS messages_recipient_id_idx ON messages (recipient_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages (created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  emoji TEXT NOT NULL DEFAULT '🫘',
  is_read BOOLEAN NOT NULL DEFAULT false,
  recipient_id UUID,
  type TEXT NOT NULL DEFAULT 'info',
  pod_id UUID
);
CREATE INDEX IF NOT EXISTS notifications_pod_id_idx ON notifications (pod_id);
CREATE INDEX IF NOT EXISTS notifications_recipient_id_idx ON notifications (recipient_id);

CREATE TABLE IF NOT EXISTS important_dates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  title TEXT NOT NULL,
  date DATE NOT NULL,
  count_up BOOLEAN NOT NULL DEFAULT false,
  recurring BOOLEAN NOT NULL DEFAULT false,
  emoji TEXT NOT NULL DEFAULT '📅',
  pinned BOOLEAN NOT NULL DEFAULT false,
  pod_id UUID
);
CREATE INDEX IF NOT EXISTS important_dates_pod_id_idx ON important_dates (pod_id);

-- ---------------------------------------------------------------------------
-- Persisted product records (formerly in-memory fakes)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  pod_id UUID NOT NULL,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  country TEXT,
  emoji TEXT NOT NULL DEFAULT '✈️',
  status TEXT NOT NULL DEFAULT 'draft',
  origin TEXT NOT NULL DEFAULT 'manual',
  start_date DATE,
  end_date DATE,
  flexible_dates BOOLEAN NOT NULL DEFAULT false,
  participant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  cities JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget_minor INTEGER,
  currency TEXT NOT NULL DEFAULT 'SGD',
  itinerary JSONB NOT NULL DEFAULT '[]'::jsonb,
  cost_breakdown JSONB NOT NULL DEFAULT '[]'::jsonb,
  rating INTEGER,
  source_idea_id UUID,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS trips_pod_id_idx ON trips (pod_id);

CREATE TABLE IF NOT EXISTS ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_id UUID NOT NULL,
  pod_id UUID NOT NULL,
  title TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '💡',
  description TEXT,
  destination TEXT,
  country TEXT,
  category TEXT NOT NULL DEFAULT 'activity',
  source_type TEXT NOT NULL DEFAULT 'user',
  estimated_cost_minor INTEGER,
  duration_days INTEGER,
  activities JSONB NOT NULL DEFAULT '[]'::jsonb,
  preferred_month TEXT,
  preferred_dates TEXT,
  creator_stance TEXT,
  stage_override TEXT,
  compromise_options JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_rationale TEXT,
  converted_trip_id UUID
);
CREATE INDEX IF NOT EXISTS ideas_pod_id_idx ON ideas (pod_id);

CREATE TABLE IF NOT EXISTS idea_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_id UUID NOT NULL,
  voter_id UUID NOT NULL,
  stance TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idea_votes_idea_voter_idx ON idea_votes (idea_id, voter_id);
CREATE INDEX IF NOT EXISTS idea_votes_idea_id_idx ON idea_votes (idea_id);

CREATE TABLE IF NOT EXISTS pod_worlds (
  pod_id UUID PRIMARY KEY,
  xp INTEGER NOT NULL DEFAULT 0,
  peanuts INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS garden_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL,
  kind TEXT NOT NULL DEFAULT 'plant',
  slot INTEGER NOT NULL,
  catalog_id TEXT NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  rarity TEXT NOT NULL DEFAULT 'common',
  provenance TEXT NOT NULL DEFAULT 'earned',
  source_label TEXT,
  memory_id UUID,
  planted_at TIMESTAMPTZ,
  grows_seconds INTEGER NOT NULL DEFAULT 60,
  water_boost DOUBLE PRECISION NOT NULL DEFAULT 0,
  watered_at TIMESTAMPTZ,
  harvested_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS garden_entries_pod_id_idx ON garden_entries (pod_id);

CREATE TABLE IF NOT EXISTS seed_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL,
  catalog_id TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'earned',
  quantity INTEGER NOT NULL DEFAULT 1,
  earned_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS seed_inventory_pod_catalog_idx ON seed_inventory (pod_id, catalog_id, provenance);
CREATE INDEX IF NOT EXISTS seed_inventory_pod_id_idx ON seed_inventory (pod_id);

CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL,
  created_by_id UUID NOT NULL,
  title TEXT NOT NULL,
  caption TEXT,
  date DATE NOT NULL,
  location TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  tag TEXT NOT NULL DEFAULT 'everyday',
  photo_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  trip_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_pod_id_idx ON memories (pod_id);
CREATE INDEX IF NOT EXISTS memories_created_by_id_idx ON memories (created_by_id);

CREATE TABLE IF NOT EXISTS unlocked_collectibles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL,
  catalog_id TEXT NOT NULL,
  earned_by TEXT NOT NULL,
  memory_id UUID,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  displayed BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS unlocked_collectibles_pod_catalog_idx ON unlocked_collectibles (pod_id, catalog_id);
CREATE INDEX IF NOT EXISTS unlocked_collectibles_pod_id_idx ON unlocked_collectibles (pod_id);

CREATE TABLE IF NOT EXISTS bucket_list_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL,
  created_by_id UUID NOT NULL,
  title TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '✨',
  country TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  state TEXT NOT NULL DEFAULT 'dream',
  trip_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bucket_list_items_pod_id_idx ON bucket_list_items (pod_id);

CREATE TABLE IF NOT EXISTS date_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL,
  created_by_id UUID NOT NULL,
  catalog_id TEXT,
  title TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '💛',
  is_online BOOLEAN NOT NULL DEFAULT false,
  scheduled_at TIMESTAMPTZ,
  participant_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'scheduled'
);
CREATE INDEX IF NOT EXISTS date_activities_pod_id_idx ON date_activities (pod_id);

CREATE TABLE IF NOT EXISTS wallets (
  pod_id UUID PRIMARY KEY,
  currency TEXT NOT NULL DEFAULT 'SGD',
  balance_minor INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🧾',
  amount_minor INTEGER NOT NULL,
  due_date DATE NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly',
  paid_by_id UUID,
  split_percent JSONB NOT NULL DEFAULT '{}'::jsonb,
  category TEXT NOT NULL DEFAULT 'other',
  last_paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS wallet_bills_pod_id_idx ON wallet_bills (pod_id);

CREATE TABLE IF NOT EXISTS wallet_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🎯',
  target_minor INTEGER NOT NULL,
  saved_minor INTEGER NOT NULL DEFAULT 0,
  trip_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_goals_pod_id_idx ON wallet_goals (pod_id);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL,
  actor_id UUID,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  description TEXT NOT NULL,
  bill_id UUID,
  goal_id UUID,
  trip_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_transactions_pod_id_idx ON wallet_transactions (pod_id);

CREATE TABLE IF NOT EXISTS reward_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pod_id UUID NOT NULL,
  redeemed_by_id UUID NOT NULL,
  catalog_id TEXT NOT NULL,
  peanut_cost INTEGER NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reward_redemptions_pod_id_idx ON reward_redemptions (pod_id);
