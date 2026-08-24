-- The rest of what the New Client form asks for.
--
-- Chris, 2026-08-23: "build New Client for real."
--
-- The form has asked twelve questions since it was drawn, and its Save button
-- called saveForm() -- a toast and a close, storing nothing. Wiring it to the
-- create_client endpoint that already exists covers five of the twelve (name,
-- company, phone, email, address). These are the other seven. Adding them is
-- the difference between a form that works and a form that quietly throws
-- half of what he typed away, which is the same defect in a nicer suit.
--
-- All nullable text: none of them is required to create a client, and a
-- required field here would break the Schedule board's quick-add path that
-- already uses this endpoint with a name alone.
alter table clients add column if not exists client_type text;
alter table clients add column if not exists preferred_contact text;
alter table clients add column if not exists source text;
alter table clients add column if not exists brand text;
alter table clients add column if not exists membership text;
alter table clients add column if not exists second_contact text;
alter table clients add column if not exists property_notes text;

comment on column clients.client_type is 'Homeowner / Property manager / Estate (Concierge) / Builder | GC / Commercial. From the New Client form.';
comment on column clients.preferred_contact is 'Text / Call / Email -- how this client wants to be reached.';
comment on column clients.source is 'How they found us. The client-level twin of lead_pipeline.lead_source.';
comment on column clients.brand is 'Which of the businesses this client belongs to (Greenwich Handyman, GH Electric, ...).';
comment on column clients.membership is 'Gold / Silver / none. Reina offers one after the first job.';
comment on column clients.second_contact is 'Spouse / property manager -- name and phone, free text.';
comment on column clients.property_notes is 'Gate code, dog, parking, access. What the crew needs before they arrive.';
