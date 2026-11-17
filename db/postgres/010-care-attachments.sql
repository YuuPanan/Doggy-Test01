CREATE TABLE care_attachments (
  id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL REFERENCES care_records(id),
  filename TEXT NOT NULL, content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),
  sha256 TEXT NOT NULL, content_base64 TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX care_attachment_record ON care_attachments(record_id,created_at,id);
