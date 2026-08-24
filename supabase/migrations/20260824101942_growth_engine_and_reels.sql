-- Growth engine + short-form video (reels) foundation.
-- ADDITIVE ONLY -- creates two new tables, touches nothing existing.
--
-- Why these two tables and not more:
--   growth_suggestions  Reina's ranked "what to do next to grow" list. Every
--                       row is produced by a scheduled scan over REAL synced
--                       data (jobs, quotes, invoices, review_requests, ad
--                       spend) and carries the evidence that produced it, so
--                       a suggestion can always be audited back to real
--                       numbers rather than trusted as an opinion.
--   content_reels       One short-form vertical video assembled from REAL job
--                       photos (public.media) with an AI-written script and a
--                       real spoken voiceover. Drafts only -- publishing
--                       still goes through the existing social_posts
--                       draft -> review -> publish state machine (sql/059),
--                       which is the single human approval gate.
--
-- Both reuse the same service-role-only RLS shape as sql/058, and the same
-- tenant_id text default the rest of the marketing stack uses.

-- ---------- growth_suggestions ----------
create table if not exists growth_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  -- What kind of move this is. Kept as a constrained vocabulary so the UI
  -- can group/ICON them without string-sniffing free text.
  kind text not null check (kind in (
    'ad_campaign','content_reel','social_post','reactivation',
    'estimate_recovery','review_push','territory','pricing','other'
  )),
  title text not null,
  -- Why Reina is recommending it, in plain language for a non-technical
  -- reader. Must be derivable from `evidence` -- never a free-floating claim.
  rationale text not null,
  -- The real numbers the suggestion was computed from, exactly as read.
  -- This is what makes a suggestion auditable instead of an opinion.
  evidence jsonb not null default '{}'::jsonb,
  -- Machine-actionable form of the suggestion, e.g.
  -- {"type":"ad_campaign_draft","platform":"meta","division":"HVAC",...}
  -- so accepting it can create the real draft without re-deriving anything.
  proposed_action jsonb not null default '{}'::jsonb,
  -- 1 = act on this first. Bounded so ordering is always meaningful.
  priority smallint not null default 3 check (priority between 1 and 5),
  status text not null default 'open' check (status in ('open','accepted','dismissed','done')),
  -- Idempotency for the recurring scan: one suggestion of a given shape per
  -- scan window, so a re-run (or a cron retry) updates rather than piles up.
  scan_key text not null,
  -- Set when accepting a suggestion produced a real draft, so the UI can
  -- link straight to it. No FK: the target table varies by kind.
  linked_record_id uuid,
  decided_at timestamptz,
  decided_by text,
  decided_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id, scan_key)
);

create index if not exists growth_suggestions_open_idx
  on growth_suggestions (tenant_id, status, priority, created_at desc);

alter table growth_suggestions enable row level security;
drop policy if exists "service role full access growth_suggestions" on growth_suggestions;
create policy "service role full access growth_suggestions"
  on growth_suggestions
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- content_reels ----------
create table if not exists content_reels (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  -- The real job whose photos this reel is built from. Both id shapes are
  -- kept because public.media carries both (job_id text, job_uuid uuid) and
  -- different callers have different ones in hand.
  job_id text,
  job_uuid uuid,
  division text,
  -- 'reel'       a ~30s vertical (9:16) short from one job's photos
  -- 'commercial' a long-form landscape (16:9) product film whose frames are
  --              captured app screens rather than job photos. Same script ->
  --              voice -> render -> approve pipeline; different aspect,
  --              length, and frame source, so one column keeps them from
  --              becoming two near-identical subsystems.
  kind text not null default 'reel' check (kind in ('reel','commercial')),
  title text,
  -- draft        script not written yet (candidate selected only)
  -- script_ready AI wrote hook/beats/caption from real job facts
  -- voice_ready  real spoken mp3 rendered and stored
  -- rendered     final vertical video assembled and stored
  -- queued       handed to social_posts as a draft for human approval
  -- rejected     a human said no
  status text not null default 'draft' check (status in (
    'draft','script_ready','voice_ready','rendered','queued','rejected'
  )),
  -- Ordered public.media ids used as the reel's frames. Order is the edit.
  photo_ids jsonb not null default '[]'::jsonb,
  -- Ordered frames that are NOT customer job photos -- captured app screens
  -- and generated title cards for a commercial. Each entry is
  -- { path, bucket, onScreenText? }. Kept separate from photo_ids so the
  -- privacy rules that apply to customer photos never have to be re-checked
  -- against a list that mixes both.
  frame_assets jsonb not null default '[]'::jsonb,
  -- { hook, beats:[{photoId, onScreenText, say}], caption, hashtags[] }
  script jsonb,
  -- Storage paths (not signed URLs -- those expire; sign on read).
  voice_path text,
  voice_name text,
  voice_duration_seconds numeric,
  video_path text,
  -- Public URL of the rendered video. Set only once the file is in a
  -- publicly-readable bucket, because Instagram and TikTok both fetch the
  -- asset server-side and cannot use a signed, expiring URL.
  video_public_url text,
  -- The social_posts row created when this reel was queued for approval.
  social_post_id uuid,
  rejected_reason text,
  created_by text not null default 'reina',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_reels_status_idx
  on content_reels (tenant_id, status, created_at desc);
-- One live reel per job: re-running the candidate scan must not produce a
-- second reel for a job that already has one. Partial, so a rejected reel
-- does not block ever making a better one for the same job later.
create unique index if not exists content_reels_one_live_per_job_idx
  on content_reels (tenant_id, job_id)
  where job_id is not null and status <> 'rejected';

alter table content_reels enable row level security;
drop policy if exists "service role full access content_reels" on content_reels;
create policy "service role full access content_reels"
  on content_reels
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- ---------- storage bucket for finished reels ----------
-- Public on purpose, and this is the one place in this migration where that
-- decision needs justifying: Instagram and TikTok both FETCH the video from
-- a URL on their own servers when publishing. A signed, expiring Supabase
-- URL fails that fetch, so a finished reel has to sit at a stable public
-- URL. Only rendered marketing videos and their voiceover tracks go here --
-- never customer photos, which stay in the private `media` bucket and are
-- read through short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'content-reels', 'content-reels', true,
  209715200,  -- 200 MB: a 60s vertical 1080p clip is far under this
  array['video/mp4','video/webm','video/quicktime','audio/mpeg','audio/mp4']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
