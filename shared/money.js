// Money in The Aquarium is kept as whole numbers of cents (decimals 2). Games from before the club
// moved to dollars were kept in whole chips (decimals 0) and still show as chips.

// $1,234.50. With cents 'auto' whole dollars drop the cents ($25), as at the table; 'always'
// keeps them ($25.00), as in ledgers where amounts line up in columns. sign '' leaves out the
// dollar sign (1,234.50), as amounts show at the table, the way PokerNow shows them.
export function fmtMoney(a, decimals = 2, cents = 'auto', sign = '$') {
  if (a === null || a === undefined || Number.isNaN(a)) return '';
  if (!decimals) return a.toLocaleString('en-US');
  const abs = Math.abs(a);
  const keep = cents === 'always' || abs % 100 !== 0;
  const s = (abs / 100).toLocaleString('en-US', { minimumFractionDigits: keep ? 2 : 0, maximumFractionDigits: 2 });
  return `${a < 0 ? '-' : ''}${sign}${s}`;
}

// Reads what someone typed ("$12.50", "12.5", "1,000") into cents. NaN when it is not an amount.
export function parseMoney(str, decimals = 2) {
  const clean = String(str ?? '').replace(/[$,\s]/g, '');
  if (clean === '' || !/^-?\d*\.?\d*$/.test(clean)) return NaN;
  const v = Number(clean);
  if (!Number.isFinite(v)) return NaN;
  return Math.round(decimals ? v * 100 : v);
}

// The value to put back in an input box: 12.50 for $12.50.
export function moneyInput(a, decimals = 2) {
  if (a === null || a === undefined) return '';
  return decimals ? (a / 100).toFixed(2) : String(a);
}
