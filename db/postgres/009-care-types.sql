ALTER TABLE care_records DROP CONSTRAINT care_records_type_check;
ALTER TABLE care_records ADD CONSTRAINT care_records_type_check
  CHECK(type IN ('weight','feeding','medication','grooming','note','toileting','custom'));
ALTER TABLE care_records ADD COLUMN custom_type TEXT;
ALTER TABLE care_records ADD CONSTRAINT care_records_custom_type_check
  CHECK((type='custom' AND custom_type IS NOT NULL) OR (type<>'custom' AND custom_type IS NULL));
