-- Adres dizini. Hesap, bildirim ve waitlist tablolarina dokunmaz.
-- 1 il, 2 ilce, 3 mahalle, 4 sokak.
-- Mahalle ve sokak satirlari 100000 ve sonrasi kimlik kullanir.
-- Sokak satirinin noktasi, bagli mahallenin merkezidir.
-- Aranan metin saklanmaz.

CREATE TABLE IF NOT EXISTS address_places (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES address_places (id),
  level SMALLINT NOT NULL CHECK (level BETWEEN 1 AND 4),
  name TEXT NOT NULL,
  name_folded TEXT NOT NULL,
  plate SMALLINT,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS address_places_folded_idx
  ON address_places (name_folded);

CREATE UNIQUE INDEX IF NOT EXISTS address_places_root_name_uq
  ON address_places (name_folded)
  WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS address_places_child_name_uq
  ON address_places (parent_id, name_folded)
  WHERE parent_id IS NOT NULL;

GRANT ALL PRIVILEGES ON TABLE address_places TO piaroute;
