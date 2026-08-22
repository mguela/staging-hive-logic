-- sql/059_organic_social_posting.sql
-- Organic social posting (paid-ads-social build, step 6). ADDITIVE ONLY.
-- NOT APPLIED to production yet (same as sql/058 -- neither has been
-- applied; both need Chris's explicit go-ahead, see MIGRATION_LEDGER.md).
--
-- Separate subsystem from ad_campaigns (api/ads.js): this is unpaid,
-- organic content posted to a Page/Instagram/TikTok profile, not a paid
-- campaign with a budget or targeting. See api/social-posts.js.

-- ---------- widen ad_platform_connections for TikTok's organic app ----------
-- TikTok's ads/Marketing API (business-api.tiktok.com, what platform=
-- 'tiktok' already means in this table) and its organic Content Posting
-- API (open.tiktokapis.com) are two entirely separate TikTok developer
-- apps with different OAuth scopes (Marketing API's advertiser token vs.
-- Content Posting API's video.publish user token via TikTok Login Kit) --
-- Meta's Page access token, by contrast, really does work for both ads and
-- organic Page/Instagram posting under one app, so no equivalent split is
-- needed for platform='meta'. 'tiktok_content' is therefore a distinct
-- connection row from 'tiktok', not a duplicate.
alter table ad_platform_connections drop constraint if exists ad_platform_connections_platform_check;
alter table ad_platform_connections add constraint ad_platform_connections_platform_check
  check (platform in ('meta','google_ads','tiktok','tiktok_content'));

-- ---------- social_posts ----------
create table if not exists social_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null default 'ghgrp',
  -- Customer-facing platform. 'meta' covers both Facebook Page and
  -- Instagram posts -- see `surface` for which.
  platform text not null check (platform in ('meta','tiktok')),
  surface text not null check (surface in ('facebook_page','instagram','tiktok_video')),
  post_type text not null check (post_type in ('text','link','image','video')),
  -- { text?, linkUrl?, mediaUrl?, mediaType? ('image'|'video') }. mediaUrl
  -- must be a real, publicly-fetchable URL -- there is no asset-upload
  -- pipeline in this codebase yet (same honest limitation as the TikTok ads
  -- adapter), so image/video posts are refused at review time if mediaUrl
  -- is missing, never fabricated or substituted with a placeholder image.
  content jsonb not null,
  status text not null default 'draft' check (status in (
    'draft','pending_review','scheduled','posted','failed','rejected'
  )),
  external_post_id text,
  scheduled_for timestamptz,
  posted_at timestamptz,
  created_by text not null default 'reina' check (created_by in ('reina','owner')),
  approved_by text,
  approved_at timestamptz,
  rejection_reason text,
  -- Same classified-issue-state message a failed publish attempt records
  -- on the connection (needs_reauth/policy_blocked/billing_blocked/
  -- needs_attention message text) -- kept here too so a failed post is
  -- self-explanatory without cross-referencing the connection's history.
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists social_posts_tenant_idx on social_posts(tenant_id);
create index if not exists social_posts_platform_idx on social_posts(platform);
create index if not exists social_posts_status_idx on social_posts(status);
-- Used by the process_scheduled_posts cron sweep (api/social-posts.js) to
-- cheaply find due posts without a full table scan.
create index if not exists social_posts_scheduled_for_idx on social_posts(scheduled_for) where status = 'scheduled';

alter table social_posts enable row level security;
drop policy if exists "service role full access social_posts" on social_posts;
create policy "service role full access social_posts"
  on social_posts
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
