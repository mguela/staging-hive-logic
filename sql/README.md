# `sql/` — DEPRECATED (historical reference only)

As of **2026-08-02**, the canonical schema source of truth is **`supabase/migrations/`**, managed
by the Supabase CLI. See [`/MIGRATIONS.md`](../MIGRATIONS.md).

The numbered `NNN_*.sql` files in this directory are the old hand-applied migration convention.
They are **kept for historical reference** — a test and various code comments / user-facing error
messages still reference specific files here, so they are not deleted — but:

> **Do not add new `.sql` files here, and do not treat these as the current schema.**
> All new schema changes go through `supabase/migrations/` (`npx supabase migration new <name>`).

The verified current-schema baseline lives at
`supabase/migrations/20260802140000_remote_baseline.sql`.
