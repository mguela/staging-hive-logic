-- Chris, 2026-08-23: "You should also be able to select the type of home,
-- Condo, coop, apartment, multifamily, townhouse etc."
--
-- The New Lead form has had a Residential/Commercial picker since it was
-- built, and it has never saved anything: the form posts `propertyType` and
-- api/track1.js has no column to put it in, so every selection has been
-- dropped on the floor. This is the column, and it holds the finer answer he
-- asked for rather than just the two-way split.
--
-- Free text rather than an enum on purpose. The list in the UI is the list
-- people should pick from, but a lead is taken down while someone is on the
-- phone, and a database constraint that rejects "carriage house" mid-call is a
-- constraint that costs a lead. Reporting groups on the known values and shows
-- the rest as typed.
alter table lead_pipeline add column if not exists property_type text;

comment on column lead_pipeline.property_type is
  'What kind of property the work is on -- single_family, condo, co_op, apartment, townhouse, multi_family_2_4, multi_family_5_plus, mobile, office, retail, industrial, restaurant, medical, multi_tenant, or free text. Set by the New Lead form.';
