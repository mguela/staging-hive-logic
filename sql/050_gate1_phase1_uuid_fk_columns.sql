DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema='public' AND t.table_name=c.table_name AND t.table_type='BASE TABLE' WHERE c.table_schema='public' AND c.column_name='client_id' AND c.data_type IN ('text','character varying') LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS client_uuid uuid', r.table_name);
    EXECUTE format('UPDATE public.%I t SET client_uuid = c.uuid_id FROM public.clients c WHERE t.client_id = c.jobber_id AND t.client_uuid IS NULL', r.table_name);
  END LOOP;
  FOR r IN SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema='public' AND t.table_name=c.table_name AND t.table_type='BASE TABLE' WHERE c.table_schema='public' AND c.column_name='job_id' AND c.data_type IN ('text','character varying') LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS job_uuid uuid', r.table_name);
    EXECUTE format('UPDATE public.%I t SET job_uuid = j.uuid_id FROM public.jobs j WHERE t.job_id = j.jobber_id AND t.job_uuid IS NULL', r.table_name);
  END LOOP;
END $$;
