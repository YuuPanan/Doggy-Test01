CREATE TABLE household_settings (
  household_id TEXT PRIMARY KEY REFERENCES households(id), timezone TEXT NOT NULL
);
CREATE TABLE pet_settings (
  pet_id TEXT PRIMARY KEY REFERENCES pets(id), timezone TEXT
);
