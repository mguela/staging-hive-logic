# Command Center widgets — design notes

> **Why this file exists:** the layout-editor fix pass (2026-08-16) was specified
> against `design/command-center-widgets-FUTURE.md` and
> `design/command-center-widgets-mockup.html`. Neither is in this repository —
> there is no `design/` directory on `main`, and neither file appears anywhere
> in the git history (checked with `git log --all -- design/` and a tree scan of
> every reachable commit). They exist outside the repo. This file records the
> one requirement change that was explicitly meant to be written back into that
> doc, so the decision isn't only in a chat log. If the FUTURE doc is ever
> committed here, fold this note into it.

## Today's Decisions is movable and resizable — but never removable

**Supersedes** the FUTURE doc's rule that Today's Decisions (Reina's Brief,
`gs-id="cc-brief"`) is fully pinned/immovable.

New rule, decided by Chris on 2026-08-16:

- Today's Decisions **can be moved** (dragged) like any other widget.
- Today's Decisions **can be resized** like any other widget.
- Today's Decisions **can never be removed** from any user's layout —
  templates and customs alike, for every user, with no exception and no
  per-role override.

### How that is enforced

| Layer | Enforcement |
|---|---|
| Widget tools | `hlCcMountEditChrome()` builds the ⤢ resize button for every widget, and builds the ✕ remove button only when `gsId !== CC_REQUIRED_WIDGET`. |
| Remove handler | `hlHideCcWidget('cc-brief')` refuses and explains, so a console call or a tampered DOM can't take it out. |
| Load | `hlCcNormalizeLayout()` runs on every layout from every source. A layout missing `cc-brief` — or carrying it as `hidden: true` — gets it re-injected at its default position. |
| Save (API) | `api/track1.js` `resource=cc_layouts` rejects any POST/PATCH whose `layout.widgets` lacks a visible `cc-brief`, with a 400 and a plain-language error. Nothing reaches the table. |
| Save (DB) | `sql/085_command_center_layouts.sql` adds a `check` constraint via `command_center_layout_has_decisions(jsonb)`, so a crafted request sent straight at PostgREST fails too. |

Regression coverage lives in `test/command-center-layout-editor.test.mjs`
(client) and `test/track1-cc-layouts.test.mjs` (API).

## Engine: GridStack, not the mockup's hand-rolled grid

The live Command Center has used **GridStack 10** since 2026-08-10 (12 columns,
`cellHeight: 40`, `margin: 8`, `float: true`) — not the mockup's 8-column /
62px-row hand-rolled pointer-capture engine. GridStack already provides the
absolute positioning, pointer drag, and collision resolution the mockup's engine
was written to demonstrate. The fix pass kept GridStack and adapted the mockup's
*interaction model* onto it (drag from a full-widget shield, edit-only tools,
explicit save/cancel) rather than swapping a working library for a
reimplementation. See `REPORT.md` for the reasoning and the trade-off.

`float: true` is deliberate: widgets stay where they are dropped instead of
floating up to close gaps. The shipped default layout relies on this (the Job
Health strip sits at `y=28`, the schedule/photos row at `y=31`, with intentional
space above), so switching to gravity would silently recompact every existing
layout.
