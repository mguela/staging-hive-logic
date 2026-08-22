DO $$ DECLARE r record; idx text; BEGIN
  FOR r IN SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('client_uuid','job_uuid','company_id') LOOP
    idx := left('ix_'||r.table_name||'_'||r.column_name,63);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I(%I)', idx, r.table_name, r.column_name);
  END LOOP;
END $$;
