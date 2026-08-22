// api/_lib/invoice-balance.js
//
// What is still owed on an invoice, in one place.
//
// This arithmetic was written out by hand in four files -- api/invoices.js,
// api/clientportal.js, track1.js's Financial Intelligence aggregation, and
// (most recently, and slightly wrong) Reina's read bridge. Every copy is a
// chance to drift, and it already had: the 7/31 "deposit-aware money math"
// fix reached the Financial Intelligence path but not the two that render
// numbers to a human, so a client who had paid a deposit was shown a balance
// that overstated what they owed. Reina's copy then forgot the discount and
// the zero clamp, so she could have quoted a figure the invoices screen
// disagreed with.
//
// TWO SOURCES, AND THEY ARE NOT EQUAL.
//
// Jobber keeps its own `balance` on an invoice. That is the authority: it
// accounts for things this repo cannot see. When it is present, use it.
//
// When it is absent -- and until 2026-08-21 it was absent on every one of the
// 2,852 invoices in the database, because the sync never asked Jobber for it
// -- the amount owed is derived from the figures that ARE present. Derived is
// good enough to act on and not good enough to state as fact, so the caller
// is told which it got rather than being left to assume.

// total - payments - deposit - discount, rounded to the cent, never negative.
// An invoice overpaid via deposit owes nothing; it does not owe a negative
// amount, and showing one to a client would be worse than useless.
export function deriveInvoiceBalance(invoice) {
  const total = Number(invoice && invoice.total) || 0;
  const payments = Number(invoice && invoice.payments) || 0;
  const deposit = Number(invoice && invoice.deposit) || 0;
  const discount = Number(invoice && invoice.discount) || 0;
  return Math.max(0, Math.round((total - payments - deposit - discount) * 100) / 100);
}

// The amount owed, and whether it came from Jobber or from arithmetic.
export function invoiceAmountDue(invoice) {
  const stored = invoice == null ? null : Number(invoice.balance);
  if (invoice && invoice.balance != null && Number.isFinite(stored)) {
    return { amountDue: Math.max(0, Math.round(stored * 100) / 100), isExact: true };
  }
  return { amountDue: deriveInvoiceBalance(invoice), isExact: false };
}
