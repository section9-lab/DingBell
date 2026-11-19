-- Customer-safe product service profile. This table must never hold purchase cost,
-- supplier, commission, margin or exact warehouse quantities. AI reads only this table
-- plus product facts and stock availability.
CREATE TABLE product_service_profile (
  organization_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  description TEXT,
  description_state TEXT NOT NULL DEFAULT 'pending' CHECK (description_state IN ('pending','complete','unavailable')),
  description_due_at INTEGER NOT NULL DEFAULT 0,
  description_attempt INTEGER NOT NULL DEFAULT 0 CHECK (description_attempt BETWEEN 0 AND 3),
  attributes_json TEXT,
  attributes_state TEXT NOT NULL DEFAULT 'pending' CHECK (attributes_state IN ('pending','complete','unavailable')),
  attributes_due_at INTEGER NOT NULL DEFAULT 0,
  attributes_attempt INTEGER NOT NULL DEFAULT 0 CHECK (attributes_attempt BETWEEN 0 AND 3),
  length_mm INTEGER,
  width_mm INTEGER,
  height_mm INTEGER,
  dimension_unit TEXT,
  weight_g INTEGER,
  weight_unit TEXT,
  observed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store_id, product_id),
  FOREIGN KEY (store_id, organization_id, product_id)
    REFERENCES product(store_id, organization_id, id) ON DELETE CASCADE,
  CHECK (description IS NULL OR length(description) <= 8000),
  CHECK (attributes_json IS NULL OR (json_valid(attributes_json) AND json_type(attributes_json) = 'array')),
  CHECK (length_mm IS NULL OR length_mm > 0),
  CHECK (width_mm IS NULL OR width_mm > 0),
  CHECK (height_mm IS NULL OR height_mm > 0),
  CHECK (weight_g IS NULL OR weight_g > 0),
  CHECK (dimension_unit IS NULL OR length(dimension_unit) BETWEEN 1 AND 8),
  CHECK (weight_unit IS NULL OR length(weight_unit) BETWEEN 1 AND 8)
);

-- Attribute labels are category/type scoped. Only labels are cached; values stay on the product.
CREATE TABLE product_category_attribute (
  description_category_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('RU','EN','ZH_HANS')),
  attribute_id TEXT NOT NULL,
  name TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (description_category_id, type_id, language, attribute_id)
);

-- Existing details become due for the separate profile worker. New details enqueue their own row
-- in the same transaction. The migration is additive and does not rewrite product facts.
INSERT INTO product_service_profile (organization_id, store_id, product_id, updated_at)
SELECT organization_id, store_id, id, 0 FROM product
WHERE facts IS NOT NULL AND detail_state = 'complete';
