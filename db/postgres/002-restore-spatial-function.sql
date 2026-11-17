-- pg_restore clears search_path; generated fence shapes still need the PostGIS functions in public.
ALTER FUNCTION public.doogy_fence_shape(TEXT) SET search_path = pg_catalog, public;
