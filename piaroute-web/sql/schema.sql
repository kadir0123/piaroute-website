-- Vercel Postgres / Neon — Query sekmesinde bir kez çalıştır
CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  device TEXT NOT NULL CHECK (device IN ('android', 'ios')),
  play_email_same BOOLEAN NOT NULL DEFAULT FALSE,
  feedback_interview BOOLEAN NOT NULL DEFAULT FALSE,
  product_updates BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'invited', 'declined')),
  notes TEXT,
  ip_hash TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS applications_email_uq
  ON applications (LOWER(email));

CREATE INDEX IF NOT EXISTS applications_status_idx ON applications (status);
CREATE INDEX IF NOT EXISTS applications_created_idx ON applications (created_at DESC);
