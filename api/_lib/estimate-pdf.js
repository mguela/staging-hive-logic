// api/_lib/estimate-pdf.js
//
// jomell, 2026-08-27: an estimate emailed to a client for approval should
// carry a real PDF of its scope of work, same as an invoice already does.
// Same letterhead, same visual language, same pdf-lib approach as
// invoice-pdf.js -- reuses its LETTERHEAD/money/dateStr rather than
// duplicating them.
//
// LAW 1: no invented subtotal/discount/tax breakout. A HiveLogic estimate's
// discount/tax are just lines with type 'discount'/'tax' (see
// server/bookkeeping/src/estimates.js) -- there is no separate tracked
// figure to show as its own "Subtotal" or "Tax" row, so the line items
// table shows every real line exactly as recorded (a discount line prints
// as its own negative line) and the one real number that follows is the
// Total HiveLogic actually computed (estimateTotals().cardPrice, falling
// back to price when card pricing is off).
//
// Split into buildEstimatePlan() (pure) and generateEstimatePdf() (draws
// it), same discipline as invoice-pdf.js and for the same reason: pdf-lib
// compresses its content streams, so buildEstimatePlan is what tests can
// actually assert against.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { GH_LOGO_PNG_BASE64 } from './gh-logo-asset.js';
import { LETTERHEAD, money, dateStr } from './invoice-pdf.js';

let _estimatesEngine;
async function loadEstimatesEngine() {
  if (!_estimatesEngine) _estimatesEngine = await import('../../server/bookkeeping/src/estimates.js');
  return _estimatesEngine;
}

// estimate: the native estimate record, already run through
//   withComputedStatus() (carries .totals, .lifecycleStatus, .lines,
//   .paymentSchedule) -- same shape sendEstimate() returns.
// client: { name, first_name, phone, email } or null.
// address: { street, city, province, postal_code } or null -- not every
//   client has one on file; the plan just omits the block rather than
//   guessing.
export async function buildEstimatePlan({ estimate, client, address }) {
  const { lineCost, linePrice, paymentScheduleAmounts } = await loadEstimatesEngine();
  const est = estimate || {};
  const totals = est.totals || { price: 0, cardPrice: 0 };

  const recipientName = (client && (client.name || client.first_name)) || 'Client';
  const recipientAddressLines = [];
  if (address && address.street) {
    recipientAddressLines.push(address.street);
    const cityLine = [address.city, address.province].filter(Boolean).join(', ') + (address.postal_code ? ' ' + address.postal_code : '');
    if (cityLine.trim()) recipientAddressLines.push(cityLine);
  }
  const recipientContactLines = [];
  if (client && client.phone) recipientContactLines.push(client.phone);
  if (client && client.email) recipientContactLines.push(client.email);
  const recipientLines = [...recipientAddressLines, ...recipientContactLines];

  const statusLabel = String(est.lifecycleStatus || 'draft').replace(/\b\w/g, (c) => c.toUpperCase());
  const grandTotal = totals.cardPrice != null ? totals.cardPrice : totals.price;
  const estimateBox = {
    number: est.estimateNumber || '',
    issued: dateStr(est.sentAt || est.createdAt),
    status: statusLabel,
    total: money(grandTotal),
  };

  const linesIn = Array.isArray(est.lines) ? est.lines : [];
  const lineItems = (linesIn.length ? linesIn : [{ description: est.title || 'Work performed', qty: 1, unitCost: grandTotal }])
    .map((line) => ({
      description: line.description || 'Item',
      // jomell, 2026-08-27: the Scope of Work description typed under a
      // line item's name -- shown as its own bulleted block under the line
      // item, not folded into one paragraph. Real newlines preserved so a
      // multi-bullet description (one bullet per line, as typed) prints the
      // same way it was written; omitted entirely when there is none.
      notes: (line.notes || '').split('\n').map((s) => s.trim()).filter(Boolean),
      quantity: line.qty != null ? String(line.qty) : null,
      unit: line.unit || null,
      lineTotal: money(linesIn.length ? linePrice(line) : grandTotal),
    }));

  const totalsRows = [{ label: 'Total', value: money(grandTotal), emphasis: true }];

  // Payment Schedule: real percentage rows against the estimate's own real
  // total -- omitted entirely (not a fabricated single row) when the
  // estimate has none.
  let paymentSchedule = null;
  if (Array.isArray(est.paymentSchedule) && est.paymentSchedule.length) {
    const amounts = paymentScheduleAmounts(est);
    const rows = amounts.map((row) => ({
      statusLabel: row.isDeposit ? 'Deposit' : (row.label || 'Payment'),
      percentLabel: (Number(row.pct) || 0) + '%',
      itemLabel: row.label || 'Payment',
      amount: money(row.amount),
    }));
    const totalPct = Math.round(amounts.reduce((s, r) => s + (Number(r.pct) || 0), 0) * 10) / 10;
    const totalAmount = amounts.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    paymentSchedule = { rows, totalPct: totalPct + '%', totalAmount: money(totalAmount) };
  }

  return {
    letterhead: LETTERHEAD,
    estimateBox,
    recipientName,
    recipientLines,
    sectionLabel: est.title || null,
    lineItems,
    totals: totalsRows,
    paymentSchedule,
    footerNote: 'Thank you for the opportunity to bid this work. Please contact us with any questions regarding this estimate.',
  };
}

const NAVY = rgb(0.059, 0.153, 0.251);
const GREEN = rgb(0.373, 0.663, 0.184);
const MUT = rgb(0.38, 0.42, 0.5);
const INK = rgb(0.09, 0.12, 0.19);
const LINE = rgb(0.85, 0.87, 0.9);
const WHITE = rgb(1, 1, 1);
const PAGE_W = 612, PAGE_H = 792;
const MARGIN = 50;

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

const CONTENT_TOP = PAGE_H - 56;
const CONTENT_BOTTOM = 130;

export async function generateEstimatePdf(inputs) {
  const plan = await buildEstimatePlan(inputs);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = MARGIN;
  const right = PAGE_W - MARGIN;
  const colDesc = left, colQty = 400, colUnit = 460, colTotal = 494;

  const logoImage = await doc.embedPng(Buffer.from(GH_LOGO_PNG_BASE64, 'base64'));
  const logoAspect = logoImage.width / logoImage.height;
  const LOGO_H = 65;
  const LOGO_TOP = PAGE_H - 32;
  const LOGO_BOTTOM = LOGO_TOP - LOGO_H;
  function drawLogo() {
    const w = LOGO_H * logoAspect;
    page.drawImage(logoImage, { x: left, y: LOGO_BOTTOM, width: w, height: LOGO_H });
    return w;
  }

  function drawHeaderContact() {
    const c1 = plan.letterhead.addressLine1 + ' | ' + plan.letterhead.addressLine2;
    const c2 = plan.letterhead.phone + ' | ' + plan.letterhead.email + ' | ' + plan.letterhead.website;
    const c1w = font.widthOfTextAtSize(c1, 8);
    const c2w = font.widthOfTextAtSize(c2, 8);
    const cx = (left + right) / 2;
    page.drawText(c1, { x: cx - c1w / 2, y: y - 2, size: 8, font, color: NAVY });
    page.drawText(c2, { x: cx - c2w / 2, y: y - 13, size: 8, font, color: NAVY });
  }

  const pages = [];
  let page = doc.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = CONTENT_TOP;

  function drawTableHeader() {
    page.drawRectangle({ x: left, y: y - 20, width: right - left, height: 22, color: GREEN });
    page.drawText('LINE ITEM', { x: colDesc + 8, y: y - 14, size: 8.5, font: bold, color: WHITE });
    page.drawText('QTY', { x: colQty, y: y - 14, size: 8.5, font: bold, color: WHITE });
    page.drawText('UNIT', { x: colUnit, y: y - 14, size: 8.5, font: bold, color: WHITE });
    page.drawText('TOTAL', { x: colTotal, y: y - 14, size: 8.5, font: bold, color: WHITE });
    y -= 32;
  }

  function newPage() {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = CONTENT_TOP;
    drawLogo();
    drawHeaderContact();
    const contLabel = 'Estimate #' + plan.estimateBox.number + ' (continued)';
    const clw = bold.widthOfTextAtSize(contLabel, 10.5);
    page.drawText(contLabel, { x: (left + right) / 2 - clw / 2, y: LOGO_BOTTOM - 20, size: 10.5, font: bold, color: NAVY });
    y = LOGO_BOTTOM - 40;
    drawTableHeader();
  }

  function ensureSpace(neededHeight) {
    if (y - neededHeight < CONTENT_BOTTOM) newPage();
  }

  // ---- Header: contact line + logo, same layout as the invoice PDF ----
  drawHeaderContact();
  drawLogo();

  // ---- Estimate box (top right) ----
  const boxW = 222, boxX = right - boxW;
  let boxY = y - 54;
  page.drawRectangle({ x: boxX, y: boxY - 26, width: boxW, height: 26, color: NAVY });
  page.drawText('Estimate #' + plan.estimateBox.number, { x: boxX + 14, y: boxY - 18, size: 12.5, font: bold, color: WHITE });
  boxY -= 26;
  const boxRow = (label, value, opts = {}) => {
    boxY -= opts.pad || 20;
    if (opts.fill) page.drawRectangle({ x: boxX, y: boxY - 6, width: boxW, height: opts.pad || 20, color: NAVY });
    const labelColor = opts.fill ? WHITE : MUT;
    page.drawText(label, { x: boxX + 14, y: boxY, size: 9.5, font, color: labelColor });
    const vFont = opts.bold ? bold : font;
    const vSize = opts.size || 10.5;
    const vw = vFont.widthOfTextAtSize(value, vSize);
    const valueColor = opts.fill ? WHITE : (opts.color || INK);
    page.drawText(value, { x: boxX + boxW - 14 - vw, y: boxY, size: vSize, font: vFont, color: valueColor });
  };
  boxRow('Issued', plan.estimateBox.issued);
  boxRow('Status', plan.estimateBox.status);
  boxRow('Total', plan.estimateBox.total, { bold: true, size: 14, pad: 26, fill: true });

  // ---- Recipient, under the logo (left column) ----
  let leftColY = LOGO_BOTTOM - 18;
  page.drawText('RECIPIENT:', { x: left, y: leftColY, size: 8, font: bold, color: MUT });
  leftColY -= 15;
  page.drawText(plan.recipientName, { x: left, y: leftColY, size: 12.5, font: bold, color: NAVY });
  leftColY -= 15;
  for (const line of plan.recipientLines) {
    page.drawText(line, { x: left, y: leftColY, size: 9.5, font, color: MUT });
    leftColY -= 12;
  }

  y = Math.min(leftColY, boxY) - 20;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: LINE });
  y -= 20;

  if (plan.sectionLabel) {
    y -= 8;
    page.drawText(plan.sectionLabel, { x: left, y, size: 13, font: bold, color: NAVY });
  }
  y -= 22;

  // ---- Scope of work / line items table ----
  drawTableHeader();

  for (const item of plan.lineItems) {
    const nameLines = wrapText(item.description, bold, 10, colQty - colDesc - 16);
    // jomell, 2026-08-27: the Scope of Work description (bullet points
    // under a line item's name) prints as its own block underneath -- each
    // real line wrapped on its own rather than joined into one paragraph,
    // so a multi-bullet description keeps one bullet per line as typed.
    const noteLines = [];
    for (const raw of item.notes) {
      for (const wrapped of wrapText(raw, font, 8.5, colQty - colDesc - 24)) noteLines.push(wrapped);
    }
    const rowHeight = nameLines.length * 13 + (noteLines.length ? noteLines.length * 11 + 3 : 0) + 5;
    ensureSpace(rowHeight);
    for (let i = 0; i < nameLines.length; i++) {
      page.drawText(nameLines[i], { x: colDesc + 8, y, size: 10, font: bold, color: INK });
      if (i === 0) {
        if (item.quantity != null) page.drawText(item.quantity, { x: colQty, y, size: 9.5, font, color: INK });
        if (item.unit) page.drawText(item.unit, { x: colUnit, y, size: 9.5, font, color: INK });
        page.drawText(item.lineTotal, { x: colTotal, y, size: 9.5, font: bold, color: INK });
      }
      y -= 13;
    }
    if (noteLines.length) y -= 3;
    for (const noteLine of noteLines) {
      page.drawText(noteLine, { x: colDesc + 14, y, size: 8.5, font, color: MUT });
      y -= 11;
    }
    y -= 5;
  }

  // ---- Totals block ----
  const totalsHeight = 6 + 22 + plan.totals.reduce((h, row) => h + (row.emphasis ? 18 : 16), 0);
  ensureSpace(totalsHeight);
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: LINE });
  y -= 22;
  const totalsX = right - 200;
  for (const row of plan.totals) {
    const vFont = row.emphasis ? bold : font;
    const vSize = row.emphasis ? 12 : 10;
    const color = row.emphasis ? NAVY : MUT;
    page.drawText(row.label, { x: totalsX, y, size: vSize, font: row.emphasis ? bold : font, color });
    const vw = vFont.widthOfTextAtSize(row.value, vSize);
    page.drawText(row.value, { x: right - vw, y, size: vSize, font: vFont, color: row.emphasis ? color : INK });
    y -= row.emphasis ? 18 : 16;
  }

  // ---- Payment Schedule (its own page, matching the invoice PDF's) ----
  if (plan.paymentSchedule) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    y = CONTENT_TOP;
    drawLogo();
    drawHeaderContact();
    y = LOGO_BOTTOM - 20;
    page.drawText('Payment Schedule', { x: left, y, size: 15, font: bold, color: NAVY });
    y -= 12;
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1.5, color: NAVY });
    y -= 24;

    const colStatus = left, colPct = 220, colItem = 280, colAmt = 494;
    page.drawText('STATUS', { x: colStatus, y, size: 8.5, font: bold, color: MUT });
    page.drawText('%', { x: colPct, y, size: 8.5, font: bold, color: MUT });
    page.drawText('ITEM', { x: colItem, y, size: 8.5, font: bold, color: MUT });
    page.drawText('AMOUNT', { x: colAmt, y, size: 8.5, font: bold, color: MUT });
    y -= 10;
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: LINE });
    y -= 20;

    plan.paymentSchedule.rows.forEach((row, i) => {
      if (i % 2 === 1) page.drawRectangle({ x: left, y: y - 6, width: right - left, height: 20, color: rgb(0.97, 0.97, 0.98) });
      page.drawText(row.statusLabel, { x: colStatus, y, size: 10, font: bold, color: NAVY });
      page.drawText(row.percentLabel, { x: colPct, y, size: 10, font, color: INK });
      page.drawText(row.itemLabel, { x: colItem, y, size: 10, font, color: INK });
      const aw = font.widthOfTextAtSize(row.amount, 10);
      page.drawText(row.amount, { x: right - aw, y, size: 10, font: bold, color: INK });
      y -= 22;
    });
    y -= 4;
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 1, color: LINE });
    y -= 20;
    page.drawText('Total', { x: colStatus, y, size: 10, font: bold, color: NAVY });
    page.drawText(plan.paymentSchedule.totalPct, { x: colPct, y, size: 10, font: bold, color: NAVY });
    const taw = font.widthOfTextAtSize(plan.paymentSchedule.totalAmount, 10);
    page.drawText(plan.paymentSchedule.totalAmount, { x: right - taw, y, size: 10, font: bold, color: NAVY });
  }

  // ---- Footer ----
  const footY = 80;
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: left, y: footY + 26 }, end: { x: right, y: footY + 26 }, thickness: 1, color: LINE });
    if (i === 0) {
      p.drawText(plan.footerNote, { x: left, y: footY, size: 9, font, color: MUT });
    }
    if (pages.length > 1) {
      const label = `Page ${i + 1} of ${pages.length}`;
      const lw = font.widthOfTextAtSize(label, 8);
      p.drawText(label, { x: right - lw, y: footY - 14, size: 8, font, color: MUT });
    }
  });

  return doc.save();
}
