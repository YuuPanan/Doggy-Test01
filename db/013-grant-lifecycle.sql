CREATE TRIGGER revoke_grants_after_member_removal
AFTER DELETE ON household_members
BEGIN
  UPDATE location_shares
  SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  WHERE created_by=OLD.user_id AND revoked_at IS NULL
    AND pet_id IN (SELECT id FROM pets WHERE household_id=OLD.household_id);
  UPDATE support_tickets
  SET diagnostics_revoked_at=COALESCE(diagnostics_revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      diagnostics_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE created_by=OLD.user_id AND diagnostics_consented_at IS NOT NULL
    AND (diagnostics_json IS NOT NULL OR diagnostics_revoked_at IS NULL)
    AND pet_id IN (SELECT id FROM pets WHERE household_id=OLD.household_id);
END;

CREATE TRIGGER revoke_shares_after_role_downgrade
AFTER UPDATE OF role ON household_members
WHEN NEW.role='viewer' AND OLD.role!='viewer'
BEGIN
  UPDATE location_shares
  SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  WHERE created_by=OLD.user_id AND revoked_at IS NULL
    AND pet_id IN (SELECT id FROM pets WHERE household_id=OLD.household_id);
END;

CREATE TRIGGER revoke_grants_after_device_unbind
AFTER UPDATE OF unbound_at ON device_bindings
WHEN OLD.unbound_at IS NULL AND NEW.unbound_at IS NOT NULL
BEGIN
  UPDATE location_shares
  SET revoked_at=COALESCE(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  WHERE binding_id=OLD.id AND revoked_at IS NULL;
  UPDATE support_tickets
  SET diagnostics_revoked_at=COALESCE(diagnostics_revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      diagnostics_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE binding_id=OLD.id AND diagnostics_consented_at IS NOT NULL
    AND (diagnostics_json IS NOT NULL OR diagnostics_revoked_at IS NULL);
END;
