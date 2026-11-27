-- Kamuya acik kurumlar. Hesap tablolarina dokunmaz.
-- Aranan metin saklanmaz.

CREATE TABLE IF NOT EXISTS public_institutions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_folded TEXT NOT NULL,
  category TEXT NOT NULL,
  city_folded TEXT,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180)
);

CREATE INDEX IF NOT EXISTS public_institutions_folded_idx
  ON public_institutions (name_folded);

CREATE INDEX IF NOT EXISTS public_institutions_category_idx
  ON public_institutions (category);

GRANT ALL PRIVILEGES ON TABLE public_institutions TO piaroute;
