-- 011_reina_todo.sql
-- ADDITIVE ONLY. Backs the in-app "Team To-Do" card (Chris's ask,
-- 2026-07-21): the master to-do list, currently only visible via a Claude
-- artifact/Google Doc that Jovie's Team account can't see, now also lives
-- in the app itself so anyone who opens HiveLogic sees the same current
-- list -- refreshed hourly by the "Reina Master To-Do Refresh" scheduled
-- task via resource=reina_todo_set (see api/track1.js).
--
-- Single-row table (id is always 'current') -- this is a live snapshot,
-- not a history. Run this once in the Supabase SQL editor (Project ->
-- SQL Editor -> New query -> paste -> Run) before the new
-- resource=reina_todo_get / resource=reina_todo_set endpoints or the
-- Command Center "Team To-Do" card will work. Safe to run more than once.

create table if not exists reina_todo (
  id text primary key default 'current',
  sections jsonb not null default '[]'::jsonb,
  flags jsonb not null default '[]'::jsonb,
  content_md text,
  source text,
  generated_at timestamptz not null default now()
);

-- Seed one empty row so the app has something to fetch (200 + null
-- sections) instead of a 404 before the first hourly refresh runs.
insert into reina_todo (id, sections, flags, source)
values ('current', '[]'::jsonb, '[]'::jsonb, 'seed')
on conflict (id) do nothing;
