DO $$ DECLARE r record; cname text; BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_clients_uuid') THEN ALTER TABLE public.clients ADD CONSTRAINT uq_clients_uuid UNIQUE USING INDEX ux_clients_uuid; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='uq_jobs_uuid') THEN ALTER TABLE public.jobs ADD CONSTRAINT uq_jobs_uuid UNIQUE USING INDEX ux_jobs_uuid; END IF;
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='client_uuid' LOOP
    cname := left('fk_'||r.table_name||'_client_uuid',63);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=cname) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (client_uuid) REFERENCES public.clients(uuid_id) NOT VALID', r.table_name, cname);
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', r.table_name, cname);
    END IF;
  END LOOP;
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='job_uuid' LOOP
    cname := left('fk_'||r.table_name||'_job_uuid',63);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=cname) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (job_uuid) REFERENCES public.jobs(uuid_id) NOT VALID', r.table_name, cname);
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', r.table_name, cname);
    END IF;
  END LOOP;
END $$;
