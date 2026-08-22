-- =============================================================================
-- Replacement VALUES block for sql/072_cost_benchmarks_seed.sql
-- Source: HiveLogic cost model, 12 sections / 132 line items
-- Trade: design_build | Size band: 2m_5m | Region: northeast
-- Generated 2026-08-14. Row count verified below.
-- =============================================================================

BEGIN;

DELETE FROM cost_benchmarks
 WHERE trade = 'design_build'
   AND size_band = '2m_5m'
   AND region = 'northeast';

INSERT INTO cost_benchmarks
  (trade, size_band, region, section, name, note, amount, frequency, cost_type, sort_order)
VALUES
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Field wages', '6 techs · blended base rate', 31, 'per_field_hour', 'direct', 1),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Field payroll taxes', 'FICA 6.2 + Medicare 1.45', 7.65, 'pct_field_wages', 'direct', 2),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Federal & state unemployment', 'FUTA 0.6 + CT SUTA 3.4 on wage base', 1.2, 'pct_field_wages', 'direct', 3),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Workers'' comp — class 5645', 'Carpentry · $13.80 per $100 of payroll', 13.8, 'pct_field_wages', 'direct', 4),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Field health insurance', 'Employer share', 11, 'pct_field_wages', 'direct', 5),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', '401(k) safe harbor match', '3% of eligible wages', 3, 'pct_field_wages', 'direct', 6),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Life, AD&D & disability', 'Group policy', 1.4, 'pct_field_wages', 'direct', 7),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Owner reasonable compensation', 'W2 salary, not distributions', 120000, 'yr', 'fixed', 8),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Office manager', 'Salary', 62400, 'yr', 'fixed', 9),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Estimator / project manager', 'Salary', 78000, 'yr', 'fixed', 10),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Burden on office & owner payroll', 'Taxes, comp class 8810, health, 401(k)', 73192, 'yr', 'fixed', 11),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Bonuses & profit share', 'Paid at year end', 18000, 'yr', 'variable', 12),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Training & certification', 'OSHA, trade CE, manufacturer', 6800, 'yr', 'fixed', 13),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Uniforms & PPE', 'Per person', 55, 'per_employee_mo', 'variable', 14),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Cell phone stipend', 'Per person', 60, 'per_employee_mo', 'fixed', 15),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Per diem & crew travel', 'Out-of-area work', 3200, 'yr', 'variable', 16),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Recruiting & hiring', 'Ads, screening, drug tests', 4200, 'yr', 'variable', 17),
  ('design_build', '2m_5m', 'northeast', 'Payroll & burden', 'Payroll processing fees', 'Base plus per-employee per run', 1900, 'yr', 'fixed', 18),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Loan & lease payments', '4 financed vehicles + trailer', 3410, 'mo', 'fixed', 19),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Depreciation on owned units', 'Paid-off dump truck', 4200, 'yr', 'fixed', 20),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Commercial auto insurance', '6 units', 940, 'mo', 'fixed', 21),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Fuel', 'Blended $/mile', 0.21, 'per_mile', 'variable', 22),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Preventive maintenance', 'Oil, filters, fluids, inspections', 0.09, 'per_mile', 'variable', 23),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Tires', 'Replacement cycle', 4800, 'yr', 'variable', 24),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Unscheduled repairs', 'Brakes, transmissions, breakdowns', 7200, 'yr', 'variable', 25),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Registration, DOT & emissions', 'Annual per unit', 1340, 'yr', 'fixed', 26),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Tolls & parking', 'EZ-Pass + city jobs', 1850, 'yr', 'variable', 27),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'GPS & telematics', 'Per vehicle', 22, 'per_vehicle_mo', 'fixed', 28),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Wraps & lettering', 'Amortized over 4 years', 2400, 'yr', 'fixed', 29),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Roadside assistance', 'Commercial plan', 540, 'yr', 'fixed', 30),
  ('design_build', '2m_5m', 'northeast', 'Vehicles & fleet', 'Replacement sinking fund', 'Per mile, so the next truck is cash', 0.14, 'per_mile', 'reserve', 31),
  ('design_build', '2m_5m', 'northeast', 'Tools, equipment & consumables', 'Heavy equipment lease', 'Mini-excavator + trailer', 890, 'mo', 'fixed', 32),
  ('design_build', '2m_5m', 'northeast', 'Tools, equipment & consumables', 'Small tool replacement', 'Per field hour — drills, blades, bits', 1.1, 'per_billable_hour', 'variable', 33),
  ('design_build', '2m_5m', 'northeast', 'Tools, equipment & consumables', 'Jobsite consumables', 'Fasteners, tape, glue, sandpaper, film', 0.85, 'per_billable_hour', 'variable', 34),
  ('design_build', '2m_5m', 'northeast', 'Tools, equipment & consumables', 'Equipment repair & service', 'Compressors, saws, generators', 4600, 'yr', 'variable', 35),
  ('design_build', '2m_5m', 'northeast', 'Tools, equipment & consumables', 'Inland marine insurance', 'Tools in transit and on site', 185, 'mo', 'fixed', 36),
  ('design_build', '2m_5m', 'northeast', 'Tools, equipment & consumables', 'Calibration & safety inspection', 'Lifts, harnesses, ladders', 780, 'yr', 'fixed', 37),
  ('design_build', '2m_5m', 'northeast', 'Tools, equipment & consumables', 'Shop supplies', 'Shop rags, fluids, hardware bins', 240, 'mo', 'variable', 38),
  ('design_build', '2m_5m', 'northeast', 'Tools, equipment & consumables', 'Fall protection & safety gear', 'Harnesses, scaffold, guards', 2900, 'yr', 'fixed', 39),
  ('design_build', '2m_5m', 'northeast', 'Tools, equipment & consumables', 'Equipment replacement fund', 'Sinking fund for the next machine', 6000, 'yr', 'reserve', 40),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Shop & yard lease', 'Bridgeport · thru 05/2028', 4200, 'mo', 'fixed', 41),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Office mortgage — principal & interest', 'Fairfield · owned', 2850, 'mo', 'fixed', 42),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Property tax', 'Owned office', 9400, 'yr', 'fixed', 43),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Property & liability insurance — buildings', 'Carrier billed annually', 3100, 'yr', 'fixed', 44),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Electric', 'Shop + office', 680, 'mo', 'variable', 45),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Gas & heat', 'Seasonal average', 310, 'mo', 'variable', 46),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Water, sewer & trash', 'Municipal', 185, 'mo', 'fixed', 47),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Internet & landlines', 'Business fiber', 240, 'mo', 'fixed', 48),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Alarm & security monitoring', 'Shop yard cameras', 78, 'mo', 'fixed', 49),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Janitorial', 'Weekly service', 320, 'mo', 'fixed', 50),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Building repairs & maintenance', 'Roof, doors, HVAC service', 3600, 'yr', 'variable', 51),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Snow removal & landscaping', 'Seasonal contract', 2800, 'yr', 'fixed', 52),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Shop dumpster service', 'Roll-off, monthly pull', 420, 'mo', 'variable', 53),
  ('design_build', '2m_5m', 'northeast', 'Facilities & occupancy', 'Storage container rental', 'Overflow material', 165, 'mo', 'fixed', 54),
  ('design_build', '2m_5m', 'northeast', 'Insurance & bonds', 'General liability', '$2M / $4M · Travelers', 1180, 'mo', 'fixed', 55),
  ('design_build', '2m_5m', 'northeast', 'Insurance & bonds', 'Umbrella / excess liability', '$2M over GL and auto', 280, 'mo', 'fixed', 56),
  ('design_build', '2m_5m', 'northeast', 'Insurance & bonds', 'Builder''s risk', 'Per project, averaged against revenue', 0.15, 'pct_revenue', 'direct', 57),
  ('design_build', '2m_5m', 'northeast', 'Insurance & bonds', 'Professional liability / E&O', 'Design-build exposure', 4200, 'yr', 'fixed', 58),
  ('design_build', '2m_5m', 'northeast', 'Insurance & bonds', 'Cyber liability', 'Client data and payment systems', 1450, 'yr', 'fixed', 59),
  ('design_build', '2m_5m', 'northeast', 'Insurance & bonds', 'Employment practices liability', 'EPLI', 2100, 'yr', 'fixed', 60),
  ('design_build', '2m_5m', 'northeast', 'Insurance & bonds', 'Key man life', 'Owner-dependent revenue', 145, 'mo', 'fixed', 61),
  ('design_build', '2m_5m', 'northeast', 'Insurance & bonds', 'Surety bond', '$15,000 · state required', 950, 'yr', 'fixed', 62),
  ('design_build', '2m_5m', 'northeast', 'Insurance & bonds', 'Broker fees & audit true-up', 'Annual payroll audit adjustment', 2400, 'yr', 'variable', 63),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'State home improvement license', 'CT HIC renewal', 220, 'yr', 'fixed', 64),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'Trade licenses', 'Electrical E-1, plumbing P-1', 900, 'yr', 'fixed', 65),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'Municipal registrations', 'Per-town contractor registration', 640, 'yr', 'fixed', 66),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'EPA lead-safe recertification', 'RRP · pre-1978 homes', 300, 'yr', 'fixed', 67),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'OSHA 10 / 30 training', 'Crew certification', 1200, 'yr', 'fixed', 68),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'Annual report & franchise tax', 'Secretary of State', 500, 'yr', 'fixed', 69),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'CPA — monthly close & advisory', 'Bookkeeping review', 850, 'mo', 'fixed', 70),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'CPA — annual tax return & review', 'Business plus owner', 6500, 'yr', 'fixed', 71),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'Attorney — retainer & contract review', 'Contracts, liens, collections', 4800, 'yr', 'fixed', 72),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'Association dues', 'NARI, NAHB, Chamber, BBB', 2340, 'yr', 'fixed', 73),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'Continuing education', 'Code updates, trade schools', 1800, 'yr', 'fixed', 74),
  ('design_build', '2m_5m', 'northeast', 'Licenses, compliance & professional', 'Permits & inspection fees', 'Per job, passed through', 0.4, 'pct_revenue', 'direct', 75),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'HiveLogic', 'Per seat', 89, 'per_employee_mo', 'fixed', 76),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'QuickBooks Online Advanced', 'Accounting', 235, 'mo', 'fixed', 77),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'Payroll platform base fee', 'Gusto', 80, 'mo', 'fixed', 78),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'Estimating & takeoff', 'Measuring and pricing', 149, 'mo', 'fixed', 79),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'Design software', 'CAD / Chief Architect', 199, 'mo', 'fixed', 80),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'Microsoft 365', 'Per seat', 22, 'per_employee_mo', 'fixed', 81),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'VoIP phone seats', 'Per seat', 28, 'per_employee_mo', 'fixed', 82),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'Jobsite photo platform', 'CompanyCam', 89, 'mo', 'fixed', 83),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'Cloud storage & backup', 'Documents and photo archive', 65, 'mo', 'fixed', 84),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'Website hosting & domains', 'Annual', 480, 'yr', 'fixed', 85),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'Email marketing platform', 'Newsletters and campaigns', 79, 'mo', 'fixed', 86),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'Password manager & endpoint security', 'Company-wide', 38, 'mo', 'fixed', 87),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'Hardware refresh', 'Laptops, tablets, phones · amortized', 7200, 'yr', 'fixed', 88),
  ('design_build', '2m_5m', 'northeast', 'Technology & software', 'IT support', 'Managed service', 350, 'mo', 'fixed', 89),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Google Ads & Local Services', 'Paid search', 2400, 'mo', 'variable', 90),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Meta & social ads', 'Facebook, Instagram', 900, 'mo', 'variable', 91),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Lead marketplaces', 'Angi, Houzz, Thumbtack', 1150, 'mo', 'variable', 92),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'SEO retainer', 'Organic search', 1200, 'mo', 'fixed', 93),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Website maintenance', 'Updates and hosting support', 250, 'mo', 'fixed', 94),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Print & direct mail', 'Neighborhood mailers', 8400, 'yr', 'variable', 95),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Yard signs & vehicle graphics', 'Job site presence', 1900, 'yr', 'variable', 96),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Home shows & community events', 'Booth, staffing, materials', 6800, 'yr', 'variable', 97),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Photography & video', 'Portfolio and before/after', 4200, 'yr', 'variable', 98),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Branded swag & client gifts', 'Closing gifts, apparel', 2600, 'yr', 'variable', 99),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Sales commission', 'Percent of sold revenue', 2.5, 'pct_revenue', 'variable', 100),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Referral fees', 'Partner and past-client referrals', 0.5, 'pct_revenue', 'variable', 101),
  ('design_build', '2m_5m', 'northeast', 'Sales & marketing', 'Review & reputation management', 'Request and response tooling', 99, 'mo', 'fixed', 102),
  ('design_build', '2m_5m', 'northeast', 'Financial, banking & debt', 'Merchant card processing', 'Blended across card-paid revenue', 0.9, 'pct_revenue', 'variable', 103),
  ('design_build', '2m_5m', 'northeast', 'Financial, banking & debt', 'ACH & bank transfer fees', 'Deposits and vendor payments', 1150, 'yr', 'variable', 104),
  ('design_build', '2m_5m', 'northeast', 'Financial, banking & debt', 'Bank service & wire fees', 'Account maintenance', 84, 'mo', 'fixed', 105),
  ('design_build', '2m_5m', 'northeast', 'Financial, banking & debt', 'Line of credit interest', 'Seasonal working capital', 9600, 'yr', 'fixed', 106),
  ('design_build', '2m_5m', 'northeast', 'Financial, banking & debt', 'Term & equipment loan interest', 'Financed vehicles and machines', 7340, 'yr', 'fixed', 107),
  ('design_build', '2m_5m', 'northeast', 'Financial, banking & debt', 'Credit card interest', 'Revolving supplier cards', 2400, 'yr', 'variable', 108),
  ('design_build', '2m_5m', 'northeast', 'Financial, banking & debt', 'Bad debt & write-offs', 'Invoices never collected', 0.35, 'pct_revenue', 'variable', 109),
  ('design_build', '2m_5m', 'northeast', 'Financial, banking & debt', 'Early-payment discounts lost', 'Supplier terms not taken', 1800, 'yr', 'variable', 110),
  ('design_build', '2m_5m', 'northeast', 'Financial, banking & debt', 'Check stock, lockbox & postage', 'Physical payments', 420, 'yr', 'fixed', 111),
  ('design_build', '2m_5m', 'northeast', 'Financial, banking & debt', 'Collections & legal recovery', 'Liens and demand letters', 1600, 'yr', 'variable', 112),
  ('design_build', '2m_5m', 'northeast', 'Direct job costs', 'Materials', 'Lumber, finishes, fixtures, hardware', 30, 'pct_revenue', 'direct', 113),
  ('design_build', '2m_5m', 'northeast', 'Direct job costs', 'Subcontractors', 'Electrical, plumbing, HVAC, drywall', 15, 'pct_revenue', 'direct', 114),
  ('design_build', '2m_5m', 'northeast', 'Direct job costs', 'Equipment rental', 'Lifts, compactors, specialty tools', 1.2, 'pct_revenue', 'direct', 115),
  ('design_build', '2m_5m', 'northeast', 'Direct job costs', 'Dumpsters & disposal', 'Per job, tipping fees included', 1.1, 'pct_revenue', 'direct', 116),
  ('design_build', '2m_5m', 'northeast', 'Direct job costs', 'Delivery & freight', 'Supplier delivery charges', 0.5, 'pct_revenue', 'direct', 117),
  ('design_build', '2m_5m', 'northeast', 'Direct job costs', 'Site protection & consumables', 'Ram board, plastic, filters', 0.4, 'pct_revenue', 'direct', 118),
  ('design_build', '2m_5m', 'northeast', 'Direct job costs', 'Port-a-john & temp facilities', 'Longer projects', 0.2, 'pct_revenue', 'direct', 119),
  ('design_build', '2m_5m', 'northeast', 'Direct job costs', 'Temporary power & utilities', 'Additions and new builds', 0.1, 'pct_revenue', 'direct', 120),
  ('design_build', '2m_5m', 'northeast', 'Direct job costs', 'Punch list & final labor', 'Closeout beyond estimate', 0.6, 'pct_revenue', 'direct', 121),
  ('design_build', '2m_5m', 'northeast', 'Direct job costs', 'Warranty & callback reserve', 'Set aside on every job', 1, 'pct_revenue', 'reserve', 122),
  ('design_build', '2m_5m', 'northeast', 'Owner & entity', 'Owner health & benefits', 'Family plan', 1150, 'mo', 'fixed', 123),
  ('design_build', '2m_5m', 'northeast', 'Owner & entity', 'Retirement plan administration', 'Third-party admin and filing', 1400, 'yr', 'fixed', 124),
  ('design_build', '2m_5m', 'northeast', 'Owner & entity', 'Vehicle allowance', 'Owner truck, fuel and insurance', 900, 'mo', 'fixed', 125),
  ('design_build', '2m_5m', 'northeast', 'Owner & entity', 'Business travel & conferences', 'Industry events', 6400, 'yr', 'variable', 126),
  ('design_build', '2m_5m', 'northeast', 'Owner & entity', 'Meals & entertainment', 'Client and team, deductible portion', 4800, 'yr', 'variable', 127),
  ('design_build', '2m_5m', 'northeast', 'Owner & entity', 'Charitable giving & sponsorships', 'Little league, local causes', 3600, 'yr', 'variable', 128),
  ('design_build', '2m_5m', 'northeast', 'Owner & entity', 'Coaching, peer group & advisory', 'Owner development', 9000, 'yr', 'fixed', 129),
  ('design_build', '2m_5m', 'northeast', 'Reserves & profit target', 'Income tax reserve', 'Pass-through estimated taxes', 4.5, 'pct_revenue', 'reserve', 130),
  ('design_build', '2m_5m', 'northeast', 'Reserves & profit target', 'Slow-season cash reserve', 'Winter payroll cushion', 18000, 'yr', 'reserve', 131),
  ('design_build', '2m_5m', 'northeast', 'Reserves & profit target', 'Target net profit', 'What the business is supposed to earn', 0, 'target_net', 'reserve', 132);

-- Guard: this migration must insert exactly 132 rows.
DO $$
DECLARE c integer;
BEGIN
  SELECT count(*) INTO c FROM cost_benchmarks
   WHERE trade='design_build' AND size_band='2m_5m' AND region='northeast';
  IF c <> 132 THEN
    RAISE EXCEPTION 'cost_benchmarks seed expected 132 rows, found %', c;
  END IF;
END
$$;

COMMIT;
