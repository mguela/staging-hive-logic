# Retirement notice for the standalone HiveDoc app

This is **not part of hivelogic-live**. It is the static page served at
<https://hivedocs-flax.vercel.app> after the standalone HiveDoc app was retired on
2026-08-21, kept here so the page is version-controlled and can be redeployed.

## Why it exists

The standalone HiveDoc app (Vercel project `hivedocs`, Supabase project
`xxxutmorfqjdiugcavti`) was one of two document systems. The audit in `REPORT.md`
established that it held nothing:

| | |
|---|---|
| Documents | **0** |
| Storage objects | **0** |
| Folders | 4 (the seed taxonomy) |
| Auth users | 1 |
| Last activity | 2026-07-17 |

Every real file — 40,939 photos and counting — has always been in the main HiveLogic
project. So HiveDoc-in-HiveLogic won, and this app was retired.

The product spec is explicit that the loser gets **a redirect or banner pointing at the
survivor, not a silent deletion**. Hence a page rather than a deleted project: the old
URL keeps working and explains where files went.

All paths rewrite to `index.html`, so a deep link someone bookmarked (`/login`,
`/documents/…`) lands on the notice instead of a 404 or a login form for an app that no
longer does anything.

## Redeploying it

From this directory, link to the right project first — deploying without linking
targets whatever project the working directory resolves to, which is not this one:

```bash
npx vercel link --project hivedocs --yes
```

```bash
npx vercel deploy --prod --yes
```

`vercel link` writes `.vercel/`, `.env.local` (which holds a short-lived OIDC token)
and a local `.gitignore`. Delete all three afterwards — they are scaffolding, not part
of the page.

`framework: null` in `vercel.json` matters — the Vercel project's saved preset is
Next.js, and without the override the build runs `next build` against a directory that
has no Next app and fails.

## Verifying a deploy

The rewrite is the part worth checking: every old deep link must land on the notice
rather than 404. After deploying, confirm the page is served and that a path that used
to exist still resolves to it:

```bash
curl -s https://hivedocs-flax.vercel.app/login | grep -q "HiveDoc now lives inside HiveLogic" && echo ok
```

## What was deliberately NOT done

Neither the Vercel project nor the Supabase project was deleted or paused. Both are
empty, both are cheap to keep, and deleting either is irreversible — that call is
Chris's, and the steps are in `REPORT.md`.
