const money = value => Math.round((Number(value) || 0) * 100) / 100;

export function distributeSalesTax(lines = [], salesTaxTotal = 0) {
  const taxCents = Math.round((Number(salesTaxTotal) || 0) * 100);
  const subtotals = lines.map(line => Math.max(0, Math.round((Number(line.subtotal ?? line.amount) || 0) * 100)));
  const subtotalCents = subtotals.reduce((sum, value) => sum + value, 0);
  if (!taxCents || !subtotalCents) return subtotals.map(() => 0);
  const shares = subtotals.map((value, index) => ({ index, exact: taxCents * value / subtotalCents }));
  const cents = shares.map(share => Math.floor(share.exact));
  let remainder = taxCents - cents.reduce((sum, value) => sum + value, 0);
  shares.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.index - b.index);
  for (let index = 0; index < remainder; index += 1) cents[shares[index].index] += 1;
  return cents.map(value => value / 100);
}

export function allocationTotal(allocations = []) {
  return money(allocations.reduce((sum, allocation) => sum + money(allocation.amount), 0));
}

export function validateExpense(expense) {
  const errors = [];
  const transactionKind = expense.transactionKind || 'paid';
  const total = money(expense.total);
  const allocated = allocationTotal(expense.allocations);
  const lineTaxTotal = money((expense.allocations || []).reduce((sum, allocation) => sum + money(allocation.salesTaxAmount), 0));
  if (!expense.vendor?.trim()) errors.push('Vendor is required.');
  if (!expense.transactionDate) errors.push('Transaction date is required.');
  if (total <= 0) errors.push('Expense total must be greater than zero.');
  if (!['paid', 'bill'].includes(transactionKind)) errors.push('Choose whether this was paid now or is an unpaid vendor bill.');
  if (transactionKind === 'paid' && !expense.paymentAccountId) errors.push('Bank or credit-card account is required.');
  if (transactionKind === 'bill') {
    if (!expense.qboVendorId) errors.push('Unpaid bills require a vendor selected from the QuickBooks vendor directory.');
    if (!expense.dueDate) errors.push('Unpaid bills require a due date.');
    if (expense.dueDate && expense.transactionDate && expense.dueDate < expense.transactionDate) errors.push('Bill due date cannot be before the bill date.');
    if (expense.paymentAccountId && expense.paymentAccountId !== '2000') errors.push('Unpaid bills must credit Accounts Payable, not a bank or card account.');
  }
  if (!expense.receiptAttached) errors.push('Receipt or supporting document is required.');
  if (!expense.allocations?.length) errors.push('Every expense needs at least one owner.');
  for (const [index, allocation] of (expense.allocations || []).entries()) {
    if (!allocation.ownerType) errors.push(`Allocation ${index + 1} needs an owner type.`);
    if (!allocation.ownerId?.trim()) errors.push(`Allocation ${index + 1} needs a specific owner.`);
    if (!allocation.qboAccountId) errors.push(`Allocation ${index + 1} needs a QBO account.`);
    if (allocation.ownerType === 'unknown' && allocation.qboAccountId !== '99') errors.push(`Allocation ${index + 1} with an unknown owner must stay in Unrecorded Expenses.`);
    if (money(allocation.amount) <= 0) errors.push(`Allocation ${index + 1} must be greater than zero.`);
    if (money(allocation.salesTaxAmount) > 0 && !allocation.salesTaxState) errors.push(`Allocation ${index + 1} needs the state where its sales tax belongs.`);
    const expectedAmount = money(money(allocation.subtotal) + money(allocation.salesTaxAmount));
    if (allocation.subtotal != null && Math.abs(expectedAmount - money(allocation.amount)) > 0.009) errors.push(`Allocation ${index + 1} subtotal plus sales tax must equal its line total.`);
  }
  if (Math.abs(total - allocated) > 0.009) errors.push(`Allocations must equal the expense total. Difference: $${money(total - allocated).toFixed(2)}.`);
  if (expense.salesTaxTotal != null && Math.abs(money(expense.salesTaxTotal) - lineTaxTotal) > 0.009) errors.push('Receipt sales tax must equal the tax distributed across its lines.');
  if (expense.receiptSubtotal != null && Math.abs(money(expense.receiptSubtotal) + money(expense.salesTaxTotal) - total) > 0.009) errors.push('Receipt subtotal plus sales tax must equal the transaction total.');
  return { valid: errors.length === 0, errors, total, allocated, lineTaxTotal, difference: money(total - allocated) };
}

export function toQboPurchase(expense) {
  const validation = validateExpense(expense);
  if (!validation.valid) throw new Error(validation.errors.join(' '));
  const taxByState = (expense.allocations || []).reduce((summary, allocation) => {
    const tax = money(allocation.salesTaxAmount);
    if (tax > 0) summary[allocation.salesTaxState] = money((summary[allocation.salesTaxState] || 0) + tax);
    return summary;
  }, {});
  const taxNote = Object.entries(taxByState).map(([state, amount]) => `${state} sales tax paid $${amount.toFixed(2)}`).join('; ');
  const common = {
    TxnDate: expense.transactionDate,
    PrivateNote: [`HiveLogic expense ${expense.id || 'draft'}`, expense.memo, taxNote ? `${taxNote} (included in expense lines)` : 'No receipt sales tax'].filter(Boolean).join(' | '),
    Line: expense.allocations.map((allocation, index) => ({
      Id: String(index + 1),
      Amount: money(allocation.amount),
      DetailType: allocation.itemId ? 'ItemBasedExpenseLineDetail' : 'AccountBasedExpenseLineDetail',
      Description: [allocation.memo || expense.memo || '', money(allocation.salesTaxAmount) > 0 ? `Sales tax paid: ${allocation.salesTaxState} $${money(allocation.salesTaxAmount).toFixed(2)} (included)` : ''].filter(Boolean).join(' | '),
      ...(allocation.itemId ? {
        ItemBasedExpenseLineDetail: {
          ItemRef: { value: allocation.itemId },
          CustomerRef: allocation.customerJobId ? { value: allocation.customerJobId } : undefined,
          BillableStatus: allocation.billable ? 'Billable' : 'NotBillable',
          TaxCodeRef: { value: 'NON' }
        }
      } : {
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: allocation.qboAccountId },
          CustomerRef: allocation.customerJobId ? { value: allocation.customerJobId } : undefined,
          ClassRef: allocation.classId ? { value: allocation.classId } : undefined,
          BillableStatus: allocation.billable ? 'Billable' : 'NotBillable',
          TaxCodeRef: { value: 'NON' }
        }
      })
    }))
  };
  if ((expense.transactionKind || 'paid') === 'bill') return {
    VendorRef: { value: expense.qboVendorId },
    APAccountRef: { value: '2000' },
    DueDate: expense.dueDate,
    DocNumber: expense.reference || undefined,
    ...common
  };
  return {
    PaymentType: expense.paymentType || 'CreditCard',
    AccountRef: { value: expense.paymentAccountId },
    EntityRef: expense.qboVendorId ? { value: expense.qboVendorId, type: 'Vendor' } : undefined,
    ...common
  };
}

export function qboExpenseEntityType(expense) { return (expense.transactionKind || 'paid') === 'bill' ? 'bill' : 'purchase'; }

export function suggestOwnership({ vendor = '', text = '', total = 0 }, learnedRules = []) {
  const haystack = `${vendor} ${text}`.toLowerCase();
  const learned = learnedRules
    .filter(rule => rule.vendor && vendor.toLowerCase().includes(rule.vendor.toLowerCase()))
    .sort((a, b) => (b.uses || 0) - (a.uses || 0))[0];
  if (learned) return { ...learned.suggestion, amount: money(total), confidence: Math.min(.98, .72 + (learned.uses || 1) * .04), reason: `Learned from ${learned.uses || 1} approved ${learned.vendor} expense(s).` };
  const rules = [
    [/home depot|lowe'?s|abc supply|ferguson|romex|lumber|drywall|pipe|breaker/, { ownerType: 'job', qboAccountId: '64', reason: 'Vendor and receipt lines look like job materials.' }],
    [/subcontract|1099|independent contractor/, { ownerType: 'subcontractor', qboAccountId: '65', reason: 'Charge appears related to a subcontractor.' }],
    [/sunbelt|united rentals|tool rental|equipment rental|rental agreement/, { ownerType: 'rental', qboAccountId: '73', reason: 'Charge appears related to rented equipment or tools.' }],
    [/loan payment|principal|lender|finance charge/, { ownerType: 'loan', qboAccountId: '74', reason: 'Charge appears related to a loan and needs principal/interest review.' }],
    [/insurance|premium|policy/, { ownerType: 'insurance', qboAccountId: '68', reason: 'Charge appears to be an insurance premium.' }],
    [/office rent|warehouse rent|lease payment|landlord/, { ownerType: 'rent', qboAccountId: '75', reason: 'Charge appears related to rent or a lease.' }],
    [/fuel|gas station|shell|mobil|exxon|diesel|gasoline/, { ownerType: 'gas', qboAccountId: '76', reason: 'Charge appears related to gas or fuel.' }],
    [/repair|maintenance|service center|oil change|tire|auto parts/, { ownerType: 'maintenance', qboAccountId: '77', reason: 'Charge appears related to repairs or maintenance.' }],
    [/tool|drill|saw|compressor|equipment purchase/, { ownerType: 'tools', qboAccountId: '72', reason: 'Charge appears related to tools or equipment.' }],
    [/truck|vehicle|registration|toll|parking/, { ownerType: 'truck', qboAccountId: '67', reason: 'Charge appears related to a truck or vehicle.' }],
    [/license|permit|registration|secretary of state/, { ownerType: 'license', qboAccountId: '69', reason: 'Charge appears related to a license, permit, or registration.' }],
    [/payroll|gusto|adp|paychex|withholding|fica|medicare/, { ownerType: 'payroll', qboAccountId: '70', reason: 'Charge appears related to payroll or payroll taxes.' }],
    [/office depot|staples|software|subscription|internet|phone/, { ownerType: 'overhead', qboAccountId: '71', reason: 'Charge appears to be general company overhead.' }]
  ];
  const match = rules.find(([pattern]) => pattern.test(haystack));
  return { ...(match ? match[1] : { ownerType: '', qboAccountId: '', reason: 'Not enough history yet—choose a home and Reina will learn.' }), amount: money(total), confidence: match ? .72 : .25 };
}
