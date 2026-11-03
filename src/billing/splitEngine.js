/**
 * Deterministic bill splitting engine.
 * All amounts are in integer paisa (1 rupee = 100 paisa).
 * Uses the Largest Remainder Method for proportional distribution.
 */

/**
 * Split a total equally among N people.
 * Returns an array of N amounts in paisa that sum exactly to totalPaisa.
 */
export function equalSplit(totalPaisa, numPeople) {
  if (numPeople <= 0) return [];
  const base = Math.floor(totalPaisa / numPeople);
  const remainder = totalPaisa - base * numPeople;
  return Array.from({ length: numPeople }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Split a bill by item assignments.
 *
 * @param {object} bill - Parsed receipt: { items: [{name, totalPricePaisa}], taxPaisa, serviceChargePaisa, discountPaisa, totalPaisa }
 * @param {Array} assignments - [{ itemIndex: 0, people: ['Alice', 'Bob'] }, ...]
 * @returns {Map<string, object>} personName → { items: [{name, amount}], itemTotal, taxShare, serviceChargeShare, discountShare, grandTotal }
 */
export function itemizedSplit(bill, assignments) {
  const people = new Map(); // name → { items: [], itemTotal: 0 }

  const ensurePerson = (name) => {
    if (!people.has(name)) {
      people.set(name, { items: [], itemTotal: 0, taxShare: 0, serviceChargeShare: 0, discountShare: 0, grandTotal: 0 });
    }
    return people.get(name);
  };

  // Assign items to people
  for (const assignment of assignments) {
    const item = bill.items[assignment.itemIndex];
    if (!item) continue;

    const numSharers = assignment.people.length;
    if (numSharers === 0) continue;

    // Split item cost among sharers using equal split
    const shares = equalSplit(item.totalPricePaisa, numSharers);

    for (let i = 0; i < assignment.people.length; i++) {
      const person = ensurePerson(assignment.people[i]);
      person.items.push({
        name: item.name,
        amount: shares[i],
        shared: numSharers > 1,
      });
      person.itemTotal += shares[i];
    }
  }

  // Calculate subtotal across all people (for proportional distribution)
  const peopleEntries = [...people.entries()];
  const subtotals = peopleEntries.map(([, p]) => p.itemTotal);
  const totalItemSum = subtotals.reduce((a, b) => a + b, 0);

  // Distribute tax proportionally
  if (bill.taxPaisa > 0 && totalItemSum > 0) {
    const taxShares = distributeProportionally(bill.taxPaisa, subtotals);
    for (let i = 0; i < peopleEntries.length; i++) {
      peopleEntries[i][1].taxShare = taxShares[i];
    }
  }

  // Distribute service charge proportionally
  if (bill.serviceChargePaisa > 0 && totalItemSum > 0) {
    const scShares = distributeProportionally(bill.serviceChargePaisa, subtotals);
    for (let i = 0; i < peopleEntries.length; i++) {
      peopleEntries[i][1].serviceChargeShare = scShares[i];
    }
  }

  // Distribute discount proportionally (reduces total)
  if (bill.discountPaisa > 0 && totalItemSum > 0) {
    const discShares = distributeProportionally(bill.discountPaisa, subtotals);
    for (let i = 0; i < peopleEntries.length; i++) {
      peopleEntries[i][1].discountShare = discShares[i];
    }
  }

  // Calculate grand total per person
  for (const [, person] of people) {
    person.grandTotal = person.itemTotal + person.taxShare + person.serviceChargeShare - person.discountShare;
  }

  return people;
}

/**
 * Largest Remainder Method (Hare-Niemeyer) for proportional distribution.
 * Distributes totalPaisa among shares proportionally, ensuring the sum is exact.
 *
 * @param {number} totalPaisa - Total amount to distribute
 * @param {number[]} weights - Proportional weights (e.g., each person's item subtotal)
 * @returns {number[]} Array of integer paisa amounts that sum exactly to totalPaisa
 */
export function distributeProportionally(totalPaisa, weights) {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return weights.map(() => 0);

  // Calculate exact shares and floor them
  const exact = weights.map(w => (w / totalWeight) * totalPaisa);
  const floored = exact.map(Math.floor);
  const remainders = exact.map((e, i) => e - floored[i]);

  // Distribute leftover paisa to those with highest remainders
  let leftover = totalPaisa - floored.reduce((a, b) => a + b, 0);
  const indices = remainders.map((r, i) => i).sort((a, b) => remainders[b] - remainders[a]);

  for (let i = 0; i < leftover; i++) {
    floored[indices[i]] += 1;
  }

  return floored;
}

/**
 * Format paisa as rupees string (e.g., 45050 → "₹450.50", 10000 → "₹100")
 */
export function paisaToRupees(paisa) {
  const rupees = paisa / 100;
  return rupees % 1 === 0 ? `₹${rupees}` : `₹${rupees.toFixed(2)}`;
}

/**
 * Format a split result as a WhatsApp-friendly summary.
 *
 * @param {Map<string, object>} splitResult - From itemizedSplit()
 * @param {object} bill - Original parsed bill
 * @returns {string} Formatted message
 */
export function formatSummary(splitResult, bill) {
  const lines = [];

  if (bill.restaurant) {
    lines.push(`${bill.restaurant}\n`);
  }

  for (const [name, data] of splitResult) {
    lines.push(name);
    for (const item of data.items) {
      const shared = item.shared ? ' (shared)' : '';
      lines.push(`  ${item.name}${shared} — ${paisaToRupees(item.amount)}`);
    }
    if (data.taxShare > 0) {
      lines.push(`  Tax — ${paisaToRupees(data.taxShare)}`);
    }
    if (data.serviceChargeShare > 0) {
      lines.push(`  Service charge — ${paisaToRupees(data.serviceChargeShare)}`);
    }
    if (data.discountShare > 0) {
      lines.push(`  Discount — -${paisaToRupees(data.discountShare)}`);
    }
    lines.push(`  *Total: ${paisaToRupees(data.grandTotal)}*`);
    lines.push('');
  }

  const grandTotal = [...splitResult.values()].reduce((sum, p) => sum + p.grandTotal, 0);
  lines.push(`Bill total: ${paisaToRupees(grandTotal)}`);

  return lines.join('\n');
}

/**
 * Format an equal split as a WhatsApp-friendly summary.
 */
export function formatEqualSummary(shares, names, bill) {
  const lines = [];

  if (bill.restaurant) {
    lines.push(`${bill.restaurant}\n`);
  }

  lines.push(`Equal split between ${names.length} people\n`);

  for (let i = 0; i < names.length; i++) {
    lines.push(`${names[i]}: ${paisaToRupees(shares[i])}`);
  }

  lines.push(`\nBill total: ${paisaToRupees(bill.totalPaisa)}`);

  return lines.join('\n');
}
