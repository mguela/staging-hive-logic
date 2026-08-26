// api/_lib/invoice-pdf.js
//
// jomell, 2026-08-27: "i just received an invoice format... whenever we send
// an invoice to a client, they should receive a pdf with the details of the
// invoice." Reference: the Jobber-generated invoice PDF for Greenwich
// Handyman (Downloads/invoice format.pdf) -- same letterhead, same
// recipient/invoice-number/dates/total layout, same line-items table, same
// subtotal/total block.
//
// pdf-lib, not Puppeteer/an HTML-to-PDF service: this runs in a Vercel
// serverless function, and a headless-Chrome dependency is exactly the kind
// of cold-start/bundle-size risk that has no upside here -- the layout is a
// handful of text blocks, a table, and some rules, not arbitrary HTML.
//
// LETTERHEAD is hardcoded, not read from a company_settings row: no such
// columns (name/address/phone/tax id) exist in this schema today (checked
// before writing this), and this exact text is the one real source handed
// to me -- the PDF above. If HiveLogic ever needs multiple companies on
// their own letterhead, this constant is what moves into a real table.
//
// LAW 1: no tax line. HiveLogic-created invoices (handleCreateInvoiceFromJob)
// have no tax field at all -- subtotal and total are the same number today.
// The reference PDF's Connecticut sales tax line is Jobber/QuickBooks
// computing real tax on a real synced invoice; inventing a tax figure here
// for an HL-INV- invoice would be a number nobody actually charged.
//
// Split into buildInvoicePlan() (pure -- every string that ends up on the
// page, computed from real inputs, zero pdf-lib) and generateInvoicePdf()
// (draws that plan). pdf-lib compresses its content streams, so the actual
// PDF bytes are not text-searchable -- buildInvoicePlan is what tests assert
// against; generateInvoicePdf gets one smoke test that it produces real,
// well-formed PDF bytes.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const LETTERHEAD = {
  name: 'Greenwich Handyman Co.',
  addressLine1: '23 Bedford-Banksville Road, 23B',
  addressLine2: 'Bedford, New York 10506',
  phone: '203.618.1234',
  email: 'info@ghgrp.net',
  website: 'www.greenwichhandyman.net',
  taxId: 'GHM TAX 263700228',
};

export function money(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function dateStr(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// invoice: the invoices row (subject, invoice_number, due_date, issued_date,
//   jobber_updated_at, subtotal, total, balance, line_items).
// client: { name, first_name }.
// address: { street, city, province, postal_code } or null -- not every
//   client has one on file; the plan just omits the block rather than
//   guessing.
// job: { title, total } or null -- powers "Portion of job"; omitted when the
//   invoice has no linked job or the job carries no priced total.
// accountBalance: real sum of every invoice's balance on this job, or null
//   to omit the row entirely (never a guessed running total).
export function buildInvoicePlan({ invoice, client, address, job, accountBalance }) {
  const inv = invoice || {};

  const recipientName = (client && (client.name || client.first_name)) || 'Client';
  const recipientLines = [];
  if (address && address.street) {
    recipientLines.push(address.street);
    const cityLine = [address.city, address.province].filter(Boolean).join(', ') + (address.postal_code ? ' ' + address.postal_code : '');
    if (cityLine.trim()) recipientLines.push(cityLine);
  }

  const invoiceBox = {
    number: inv.invoice_number || '',
    issued: dateStr(inv.issued_date || inv.jobber_updated_at),
    due: dateStr(inv.due_date),
    total: money(inv.total),
    portionOfJob: null,
    accountBalance: accountBalance != null ? money(accountBalance) : null,
  };
  if (job && isFinite(Number(job.total)) && Number(job.total) > 0) {
    const pct = Math.round((Number(inv.total) / Number(job.total)) * 1000) / 10;
    invoiceBox.portionOfJob = pct + '% (' + money(inv.total) + ' of ' + money(job.total) + ')';
  }

  const lineItemsIn = Array.isArray(inv.line_items) ? inv.line_items : [];
  const lineItems = (lineItemsIn.length ? lineItemsIn : [{ description: inv.subject || 'Work performed', quantity: 1, unitPrice: inv.total, lineTotal: inv.total }])
    .map((item) => ({
      description: item.description || 'Item',
      quantity: item.quantity != null ? String(item.quantity) : null,
      unitPrice: item.unitPrice != null ? money(item.unitPrice) : null,
      lineTotal: money(item.lineTotal),
    }));

  const totals = [{ label: 'Subtotal', value: money(inv.subtotal != null ? inv.subtotal : inv.total) }];
  totals.push({ label: 'Total', value: money(inv.total), emphasis: true });
  if (inv.balance != null) totals.push({ label: 'Balance due', value: money(inv.balance), emphasis: true, danger: true });

  return {
    letterhead: LETTERHEAD,
    invoiceBox,
    recipientName,
    recipientLines,
    sectionLabel: inv.subject || null,
    lineItems,
    totals,
    footerNote: 'Thank you for your business. Please contact us with any questions regarding this invoice.',
    taxId: LETTERHEAD.taxId,
  };
}

const NAVY = rgb(0.059, 0.153, 0.251);   // #0f2740
const GREEN = rgb(0.373, 0.663, 0.184);  // #5fa92f, the reference table header
const MUT = rgb(0.38, 0.42, 0.5);
const INK = rgb(0.09, 0.12, 0.19);
const LINE = rgb(0.85, 0.87, 0.9);
const WHITE = rgb(1, 1, 1);
const PAGE_W = 612, PAGE_H = 792;
const MARGIN = 50;

// Greedy word-wrap against a known font/size, returning an array of lines
// that each fit maxWidth. Used for line-item descriptions, which can run
// longer than the column.
function wrapText(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const w of words) {
    const trial = current ? current + ' ' + w : w;
    if (font.widthOfTextAtSize(trial, size) > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = trial;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// A real quote can run to a lot of line items (a full renovation is often
// 15-30+), and pdf-lib does not paginate anything for you -- a naive
// single-page draw just keeps writing at negative Y once it runs off the
// bottom, which is not an error, it is invisible. Found live: a 30-line
// invoice silently lost its last item AND its entire totals block, and the
// footer overlapped item rows it should never have shared a page with.
// The reference Jobber PDF itself is 3 pages ("Page 1 of 3") for exactly
// this reason -- multi-page is the normal case for a real quote, not an
// edge case.
const CONTENT_TOP = PAGE_H - 56;
const CONTENT_BOTTOM = 130; // leaves clearance for the footer, drawn fixed at the bottom of every page

export async function generateInvoicePdf(inputs) {
  const plan = buildInvoicePlan(inputs);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = MARGIN;
  const right = PAGE_W - MARGIN;
  const colDesc = left, colQty = 372, colPrice = 424, colTotal = 494;

  const pages = [];
  let page = doc.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = CONTENT_TOP;

  function drawTableHeader() {
    page.drawRectangle({ x: left, y: y - 20, width: right - left, height: 22, color: GREEN });
    page.drawText('DESCRIPTION', { x: colDesc + 8, y: y - 14, size: 8.5, font: bold, color: WHITE });
    page.drawText('QTY', { x: colQty, y: y - 14, size: 8.5, font: bold, color: WHITE });
    page.drawText('UNIT PRICE', { x: colPrice, y: y - 14, size: 8.5, font: bold, color: WHITE });
    page.drawText('TOTAL', { x: colTotal, y: y - 14, size: 8.5, font: bold, color: WHITE });
    y -= 32;
  }

  function newPage() {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = CONTENT_TOP;
    page.drawText(plan.letterhead.name.toUpperCase() + ' — Invoice #' + plan.invoiceBox.number + ' (continued)', { x: left, y, size: 10.5, font: bold, color: NAVY });
    y -= 24;
    drawTableHeader();
  }

  // Starts a new page when the next block would land in the footer's
  // clearance zone. Called with the real height of the thing about to be
  // drawn, so a tall multi-line description can't itself get split in half.
  function ensureSpace(neededHeight) {
    if (y - neededHeight < CONTENT_BOTTOM) newPage();
  }

  // ---- Letterhead (page 1 only -- a continuation page gets the lighter
  // "(continued)" header newPage() draws instead) ----
  page.drawText(plan.letterhead.name.toUpperCase(), { x: left, y, size: 15, font: bold, color: NAVY });
  y -= 16;
  page.drawText(plan.letterhead.addressLine1 + ' | ' + plan.letterhead.addressLine2, { x: left, y, size: 8.5, font, color: MUT });
  y -= 12;
  page.drawText(plan.letterhead.phone + ' | ' + plan.letterhead.email + ' | ' + plan.letterhead.website, { x: left, y, size: 8.5, font, color: MUT });

  // ---- Invoice box (top right) ----
  const boxW = 222, boxX = right - boxW;
  let boxY = PAGE_H - 56;
  page.drawRectangle({ x: boxX, y: boxY - 26, width: boxW, height: 26, color: NAVY });
  page.drawText('Invoice #' + plan.invoiceBox.number, { x: boxX + 14, y: boxY - 18, size: 12.5, font: bold, color: WHITE });
  boxY -= 26;
  const boxRow = (label, value, opts = {}) => {
    boxY -= opts.pad || 20;
    page.drawText(label, { x: boxX + 14, y: boxY, size: 9.5, font, color: MUT });
    const vFont = opts.bold ? bold : font;
    const vSize = opts.size || 10.5;
    const vw = vFont.widthOfTextAtSize(value, vSize);
    page.drawText(value, { x: boxX + boxW - 14 - vw, y: boxY, size: vSize, font: vFont, color: opts.color || INK });
  };
  boxRow('Issued', plan.invoiceBox.issued);
  boxRow('Due', plan.invoiceBox.due);
  boxRow('Total', plan.invoiceBox.total, { bold: true, size: 14, pad: 24 });
  if (plan.invoiceBox.portionOfJob) boxRow('Portion of job', plan.invoiceBox.portionOfJob, { size: 8.5 });
  if (plan.invoiceBox.accountBalance) boxRow('Account balance', plan.invoiceBox.accountBalance, { bold: true, color: NAVY });

  // The invoice box can grow taller than the three-line letterhead (Portion
  // of job / Account balance are both optional rows) -- the divider has to
  // clear whichever column actually ran longer, not a fixed offset, or a
  // short box overlaps the row text below it.
  y = Math.min(y, boxY) - 20;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: LINE });
  y -= 26;

  // ---- Recipient ----
  page.drawText('BILL TO', { x: left, y, size: 8, font: bold, color: MUT });
  y -= 15;
  page.drawText(plan.recipientName, { x: left, y, size: 12.5, font: bold, color: NAVY });
  y -= 15;
  for (const line of plan.recipientLines) {
    page.drawText(line, { x: left, y, size: 9.5, font, color: MUT });
    y -= 12;
  }

  // ---- Section label (the invoice's own subject/stage, e.g. "Upon Completion") ----
  if (plan.sectionLabel) {
    y -= 8;
    page.drawText(plan.sectionLabel, { x: left, y, size: 13, font: bold, color: NAVY });
  }
  y -= 22;

  // ---- Line items table ----
  drawTableHeader();

  for (const item of plan.lineItems) {
    const descLines = wrapText(item.description, font, 9.5, colQty - colDesc - 16);
    const rowHeight = descLines.length * 13 + 5;
    // A row is drawn whole on one page, never split mid-description -- if it
    // doesn't fit what's left, the whole row (and any after it) moves to a
    // fresh page with its own table header.
    ensureSpace(rowHeight);
    for (let i = 0; i < descLines.length; i++) {
      page.drawText(descLines[i], { x: colDesc + 8, y, size: 9.5, font, color: INK });
      if (i === 0) {
        if (item.quantity != null) page.drawText(item.quantity, { x: colQty, y, size: 9.5, font, color: INK });
        if (item.unitPrice != null) page.drawText(item.unitPrice, { x: colPrice, y, size: 9.5, font, color: INK });
        page.drawText(item.lineTotal, { x: colTotal, y, size: 9.5, font: bold, color: INK });
      }
      y -= 13;
    }
    y -= 5;
  }

  // ---- Totals block (kept together with its divider, never orphaned alone
  // at the top of a page it didn't need) ----
  const totalsHeight = 6 + 22 + plan.totals.reduce((h, row) => h + (row.emphasis ? 18 : 16), 0);
  ensureSpace(totalsHeight);
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: LINE });
  y -= 22;
  const totalsX = right - 200;
  for (const row of plan.totals) {
    const vFont = row.emphasis ? bold : font;
    const vSize = row.emphasis ? 12 : 10;
    const color = row.danger ? rgb(0.72, 0.15, 0.15) : (row.emphasis ? NAVY : MUT);
    page.drawText(row.label, { x: totalsX, y, size: vSize, font: row.emphasis ? bold : font, color });
    const vw = vFont.widthOfTextAtSize(row.value, vSize);
    page.drawText(row.value, { x: right - vw, y, size: vSize, font: vFont, color: row.emphasis ? color : INK });
    y -= row.emphasis ? 18 : 16;
  }

  // ---- Footer, fixed at the bottom of every page (page numbers only when
  // there is more than one, matching the reference PDF's "Page 1 of 3") ----
  const footY = 80;
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: left, y: footY + 26 }, end: { x: right, y: footY + 26 }, thickness: 1, color: LINE });
    p.drawText(plan.footerNote, { x: left, y: footY, size: 9, font, color: MUT });
    p.drawText(plan.taxId, { x: left, y: footY - 14, size: 8, font, color: MUT });
    if (pages.length > 1) {
      const label = `Page ${i + 1} of ${pages.length}`;
      const lw = font.widthOfTextAtSize(label, 8);
      p.drawText(label, { x: right - lw, y: footY - 14, size: 8, font, color: MUT });
    }
  });

  return doc.save();
}
