-- Uygulama verisi. Waitlist tablosuna dokunmaz.

CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY,
  email TEXT,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_uq
  ON app_users (LOWER(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES app_users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK (status IN ('unconfirmed', 'confirmed', 'rejected')),
  source TEXT NOT NULL,
  hazard_type TEXT NOT NULL,
  user_label TEXT,
  note TEXT,
  photo_path TEXT,
  severity SMALLINT CHECK (severity IS NULL OR severity BETWEEN 1 AND 5),
  speed_kmh DOUBLE PRECISION,
  sensor_magnitude DOUBLE PRECISION,
  ai_is_hazard BOOLEAN,
  ai_confidence DOUBLE PRECISION,
  ai_suggested_severity SMALLINT,
  ai_hazard_type TEXT,
  ai_summary TEXT,
  confirmation_count INTEGER NOT NULL DEFAULT 0,
  confirmed_by UUID[] NOT NULL DEFAULT '{}',
  location_source TEXT,
  train_for_model BOOLEAN NOT NULL DEFAULT FALSE,
  app_version TEXT,
  import_id TEXT,
  account_uid TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS reports_import_id_uq
  ON reports (import_id)
  WHERE import_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reports_created_idx ON reports (created_at DESC);
CREATE INDEX IF NOT EXISTS reports_user_idx ON reports (user_id);

CREATE TABLE IF NOT EXISTS account_erasures (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  report_ids TEXT[] NOT NULL DEFAULT '{}',
  photo_names TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  local_purged_at TIMESTAMPTZ
);

GRANT ALL PRIVILEGES ON TABLE app_users, reports, account_erasures TO piaroute;
