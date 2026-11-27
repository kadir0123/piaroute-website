-- Taninan zincir subeleri. Hesap tablolarina dokunmaz.
-- Aranan metin saklanmaz.

CREATE TABLE IF NOT EXISTS chain_branches (
  id INTEGER PRIMARY KEY,
  brand_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_folded TEXT NOT NULL,
  category TEXT NOT NULL,
  address_place_id INTEGER,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS chain_branches_folded_idx
  ON chain_branches (name_folded);

CREATE INDEX IF NOT EXISTS chain_branches_brand_idx
  ON chain_branches (brand_id);

CREATE INDEX IF NOT EXISTS chain_branches_category_idx
  ON chain_branches (category);

GRANT ALL PRIVILEGES ON TABLE chain_branches TO piaroute;
