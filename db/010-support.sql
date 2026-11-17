CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), pet_id TEXT NOT NULL REFERENCES pets(id),
  binding_id TEXT NOT NULL REFERENCES device_bindings(id), created_by TEXT NOT NULL REFERENCES users(id),
  category TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  diagnostics_consented_at TEXT, diagnostics_expires_at TEXT, diagnostics_revoked_at TEXT, diagnostics_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX support_ticket_creator ON support_tickets(created_by,created_at DESC,id DESC);
CREATE INDEX support_ticket_status ON support_tickets(status,created_at DESC,id DESC);
CREATE TABLE support_ticket_history (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES support_tickets(id), actor_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL, reply TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX support_history_ticket ON support_ticket_history(ticket_id,created_at,id);
