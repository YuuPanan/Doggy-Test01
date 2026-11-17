CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE households (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE household_members (
  household_id TEXT NOT NULL REFERENCES households(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','caregiver','viewer')), created_at TEXT NOT NULL,
  PRIMARY KEY(household_id,user_id)
);
CREATE INDEX household_members_user ON household_members(user_id);
CREATE TABLE pets (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), name TEXT NOT NULL,
  species TEXT NOT NULL, breed TEXT, birth_date TEXT, weight_kg REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX pets_household ON pets(household_id);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, refresh_expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE household_invitations (
  id TEXT PRIMARY KEY, household_id TEXT NOT NULL REFERENCES households(id), email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('caregiver','viewer')), token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE auth_attempts (key TEXT PRIMARY KEY, window_started TEXT NOT NULL, attempts INTEGER NOT NULL);
