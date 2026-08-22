// server/bookkeeping/src/card-pricing.js
//
// Cash-discount pricing engine — pure, no I/O, shared by estimates.js,
// change-orders.js, and the T&M invoice flow (api/fieldops.js).
//
// Chris's spec (2026-07-26):
//   Merchant/processing fees are built into every estimate & invoice
//   automatically ("default an additional cost for the merchant fees on top
//   of the user entered amounts... this way it covers the fees without
//   thinking about it"), and a discount equal to the total of those fees is
//   given "at the bottom" when the client pays by Cash, Check, or ACH.
//   Rates themselves NEVER change ($225/hr stays $225/hr; materials markup
//   stays what it is) — the fee sits on top and the discount takes it back
//   off for non-card payment.
//
// COMPLIANCE FRAMING (why the words matter): Connecticut bans credit-card
// SURCHARGES outright (Conn. Gen. Stat. § 42-133ff) and Visa caps
// surcharges at 3% — but cash DISCOUNTS are legal in all 50 states, and NY
// GBL § 518 explicitly allows "higher price with an advertised cash
// discount" as long as the full (card) price is shown before payment. So:
//   - The posted/displayed total ALWAYS includes the fee (cardPrice).
//   - Client-facing copy says "cash discount", NEVER "card fee"/"surcharge".
//   - Both dollar amounts are shown before the client picks how to pay.
// Processor: United Payment Corp / Authorize.Net (Sal). Program registration
// as a cash-discount program is Sal's side of the paperwork.
//
// MATH (fee at the bottom, single rounding — Chris's call, 2026-07-26,
// matching Sal's implementation guide's "round once at the order-total
// level" rule):
//   cashPrice = sum of line prices at normal rates  (what cash/check/ACH pays)
//   cardFee   = round2(cashPrice * rateBps / 10000)
//   cardPrice = cashPrice + cardFee                  (the posted total; card pays this)
// 400 bps = 4.00%, per Sal's program. Additive (+4%), not gross-up (/0.96) —
// flagged to Chris 2026-07-26 that additive leaves ~$0.16/$100 of the fee
// uncovered if the processor takes 4% of the CHARGED amount; his call to
// keep Sal's math unless he says otherwise.

const money = value => Math.round((Number(value) || 0) * 100) / 100;

export const DEFAULT_CARD_RATE_BPS = 400; // 4.00% — Sal / United Payment Corp program rate

// Payment methods that earn the cash discount. Everything else (credit,
// debit, 'unspecified', ...) pays the posted card price.
export const DISCOUNT_PAYMENT_METHODS = Object.freeze(['cash', 'check', 'ach']);

export function isDiscountMethod(method) {
  return DISCOUNT_PAYMENT_METHODS.includes(String(method || '').trim().toLowerCase());
}

// Validates/normalizes a basis-points rate. null/undefined/'' -> fallback
// (an explicit 0 stays 0 — that's how card pricing is turned off per record).
export function normalizeCardRateBps(value, fallback = DEFAULT_CARD_RATE_BPS) {
  if (value == null || value === '') return fallback;
  const bps = Number(value);
  if (!Number.isFinite(bps) || bps < 0 || bps > 1000) {
    throw new Error('cardRateBps must be between 0 and 1000 basis points (0% to 10%).');
  }
  return Math.round(bps);
}

export function cardPricing(baseTotal, cardRateBps = DEFAULT_CARD_RATE_BPS) {
  const cashPrice = money(baseTotal);
  const rate = normalizeCardRateBps(cardRateBps);
  const cardFee = money(cashPrice * rate / 10000);
  return { cashPrice, cardFee, cardPrice: money(cashPrice + cardFee), cardRateBps: rate };
}

// Credits a received payment against the POSTED (card) amount due. A
// payment by a discount-eligible method is worth more than its face value
// against the posted total — by exactly the cash discount, no more, no
// less. Uses the record's own cardPrice/cashPrice ratio (not a re-derived
// rate) so penny rounding can never make a fully-paid cash balance come up
// short. Mixed-method partial payments (half check, half card) each credit
// correctly on their own terms.
export function creditedAmount(amount, method, { cashPrice, cardPrice }) {
  const paid = money(amount);
  if (!isDiscountMethod(method)) return paid;
  if (!(cashPrice > 0) || !(cardPrice > 0) || cardPrice === cashPrice) return paid;
  return money(paid * (cardPrice / cashPrice));
}
