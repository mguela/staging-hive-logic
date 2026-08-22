# HiveLogic ↔ Gusto Payroll Integration

Status: **built and proven end-to-end in Gusto's demo environment.** Going live
on real payroll needs one Gusto-side step (Production Pre-Approval) + credentials
— everything else is a single env-var flip.

---

## The loop

```
   HiveLogic onboarding ──(1 create employee)──▶  Gusto
   HiveLogic approved hours ──(2 push timesheet)──▶  Gusto  (runs payroll + taxes)
   HiveLogic accounting  ◀──(3 read taxes/fees)──  Gusto
```

1. **Onboard → create employee (write).** When a new hire finishes onboarding,
   they're auto-created in Gusto: employee → job → compensation. Uses
   `self_onboarding: true`, so **Gusto collects the SSN + bank details directly
   from the employee — HiveLogic never handles that PII.** The admin picks pay
   type (hourly/salary + rate) at invite time. Proven in demo (employee + job +
   hourly comp created; `comp_source: embedded:put`).
2. **Approved hours → push timesheet (write).** An approved shift is pushed to
   Gusto's Time Sheets API (`hours_worked` + `pay_classification`). Proven in
   demo (Gusto returned `201`, status `approved`, read-back confirmed).
3. **Payroll costs → read back.** The sync pulls processed payrolls (gross,
   **employer taxes, benefits**) and computes burden; Reina drafts burden-rate
   proposals for human approval. Proven in demo (13+ employees, 4 payrolls).

Only hourly employees get hours pushed; salary is paid a fixed amount by Gusto.
1099 contractors and credit-card tips are separate Gusto feeds (contractor
payments / `paycheck_tips`) — noted for later, not built.

---

## What's built

| Piece | File |
|---|---|
| Gusto OAuth (connect, refresh, status) | `api/gusto/index.js` |
| Provision employee (create + job + comp) | `api/_lib/gusto-provision.js` |
| Auto-provision on onboarding complete + `employee_pay` link | `api/invites.js` (`finish`) |
| Read sync (payroll → employee_pay / payroll_period_costs / Reina) | `api/_lib/gusto-payroll-sync.js` |
| Reina burden proposals (draft → approve) | `api/_lib/reina-proposals.js`, `api/registries.js` |
| Admin surface | `public/setup/payroll.html` |
| Diagnostics / test surface | `public/setup/payroll-test.html` |
| Durable Gusto link on the hire | `sql/080_employee_pay_gusto_link.sql` (applied: `gusto_employee_uuid`, `gusto_job_uuid` on `employee_pay`) |

**Safety guards in place:**
- The demo connection **never commits** payroll into HiveLogic (`sync` is
  dry-run-only in demo) — the demo company's fake employees can't pollute real
  data.
- The demo timesheet push refuses unless `GUSTO_ENVIRONMENT=demo`.
- Reina never writes `employee_pay`/`cost_lines` directly — draft then approve.
- No SSN/bank ever reaches HiveLogic (self-onboarding; the sync drops those
  fields at the boundary).

---

## How to go live (real payroll)

Everything above runs against **demo** today. To point it at real payroll:

1. **File Gusto Production Pre-Approval** at dev.gusto.com (Onboard → "Production
   Pre-Approval"). This is a Gusto application with lead time — it's the one
   real-world gate, and it's on your timeline.
2. When approved, Gusto issues **production** Client ID/Secret. Set in Vercel:
   `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET`,
   `GUSTO_REDIRECT_URI=https://hivelogic-live.vercel.app/api/gusto`, and
   **`GUSTO_ENVIRONMENT=production`**.
3. Redeploy → visit `/api/gusto` and authorize against your real Greenwich
   Handyman Gusto company.
4. Run the sync from `/setup/payroll.html`. In production, "Sync from Gusto" can
   commit real payroll data into HiveLogic (employee_pay + payroll_period_costs
   + Reina burden proposals for your review).

Nothing touches real payroll until step 2's env flip.

---

## Still to productionize (beyond the Gusto gate)

- **Clock → approve → push front-end.** The push mechanics are proven; the
  admin approval UI over `job_time_entries` (approve a week of hours, then push)
  is the remaining front-end work.
- **Scheduled sync.** A cron to pull payroll costs on each processed run,
  instead of the manual "Sync from Gusto" button.
- **Contractor (1099) + tips feeds** — separate Gusto endpoints, noted above.
