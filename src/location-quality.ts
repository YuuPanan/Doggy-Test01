import { Db, Row } from './db';
import { deviceTiming } from './reporting';

export async function locationPresenter(db: Db, deviceId: string, petId: string) {
  const [timing, fence] = await Promise.all([
    deviceTiming(db, deviceId),
    db.get('SELECT MAX(accuracy_limit_m) AS limit_m FROM geofences WHERE pet_id=? AND enabled=1', petId)
  ]);
  const geofenceLimit = fence!.limit_m ?? 100;
  return (row: Row): Row => {
    const { quality_flags_json, ...rest } = row;
    const flags: string[] = JSON.parse(quality_flags_json);
    const age = db.clock().getTime() - Date.parse(row.device_ts);
    const fresh = age <= timing.fresh_seconds * 1000 && age >= -60_000;
    const usable = fresh && flags.length === 0 && row.accuracy_m <= 100 && row.source === 'gnss';
    const geofenceUsable = fresh && row.source === 'gnss' && row.accuracy_m <= geofenceLimit
      && flags.every(flag => flag === 'poor_accuracy');
    return { ...rest, quality_flags: flags, freshness: fresh ? 'fresh' : 'stale',
      usable_for_tracking: usable, usable_for_geofence: geofenceUsable, geofence_accuracy_limit_m: geofenceLimit };
  };
}

export async function presentLocation(db: Db, row: Row): Promise<Row> {
  return (await locationPresenter(db, row.device_id, row.pet_id))(row);
}

export async function latestLocation(db: Db, petId: string): Promise<Row | null> {
  const binding = (await db.get('SELECT * FROM device_bindings WHERE pet_id=? AND unbound_at IS NULL', petId));
  if (!binding) return null;
  const row = (await db.get(`SELECT l.* FROM locations l JOIN device_state s ON s.last_location_id=l.id
    JOIN device_events e ON e.event_id=l.event_id WHERE s.device_id=? AND l.pet_id=? AND e.binding_id=?`,
    binding.device_id, petId, binding.id));
  if (!row) return null;
  const latest = (await presentLocation(db, row));
  if (!latest.usable_for_tracking) {
    const since = new Date(db.clock().getTime() - (await deviceTiming(db, binding.device_id)).fresh_seconds * 1000).toISOString();
    const usable = (await db.get(`SELECT l.* FROM locations l JOIN device_events e ON e.event_id=l.event_id
      WHERE l.device_id=? AND l.pet_id=? AND e.binding_id=? AND l.source='gnss' AND l.accuracy_m<=100
      AND l.quality_flags_json='[]' AND l.device_ts>=? AND l.device_ts<=?
      ORDER BY l.device_ts DESC,l.id DESC LIMIT 1`, binding.device_id, petId, binding.id, since,
      new Date(db.clock().getTime() + 60_000).toISOString()));
    latest.last_usable_location = usable ? (await presentLocation(db, usable)) : null;
  }
  return latest;
}
