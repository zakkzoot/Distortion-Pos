import test from 'node:test';
import assert from 'node:assert/strict';
import { businessDate, cashChange, discounted, isHappyHour, khrDue, khrToCents, suggestPrice, vatIncluded } from '../server/money';

const TZ = 420; // Phnom Penh
const at = (isoLocal: string) => Date.parse(isoLocal + 'Z') - TZ * 60000;

test('riel due is rounded up so the sale is never short', () => {
  assert.equal(khrDue(550, 4100), 22600); // 22,550 -> 22,600
  assert.equal(khrDue(100, 4100), 4100);
  for (let c = 1; c < 3000; c++) assert.ok(khrToCents(khrDue(c, 4100), 4100) >= c, `short at ${c}`);
});

test('change: dollars in USD, remainder in riel rounded down to 100', () => {
  assert.deepEqual(cashChange(450, 4100), { change_usd_cents: 400, change_khr: 2000 }); // 50c = 2,050 -> 2,000
  assert.deepEqual(cashChange(0, 4100), { change_usd_cents: 0, change_khr: 0 });
  assert.deepEqual(cashChange(1, 4100), { change_usd_cents: 0, change_khr: 0 });
});

test('discounts and VAT', () => {
  assert.equal(discounted(550, 2000), 440);
  assert.equal(discounted(125, 2000), 100);
  assert.equal(vatIncluded(1100, 1000), 100);
  assert.equal(vatIncluded(1100, 0), 0);
});

test('trading day runs to the cutoff hour', () => {
  assert.equal(businessDate(at('2026-11-14T01:30:00'), TZ, 6), '2026-11-13');
  assert.equal(businessDate(at('2026-11-14T06:00:00'), TZ, 6), '2026-11-14');
  assert.equal(businessDate(at('2026-11-13T18:00:00'), TZ, 6), '2026-11-13');
});

test('happy hour window, including one that wraps midnight', () => {
  const r = { enabled: true, start: '17:00', end: '19:00', days: [0, 1, 2, 3, 4, 5, 6], discount_bp: 2000 };
  assert.equal(isHappyHour(at('2026-11-13T17:00:00'), TZ, r), true);
  assert.equal(isHappyHour(at('2026-11-13T18:59:00'), TZ, r), true);
  assert.equal(isHappyHour(at('2026-11-13T19:00:00'), TZ, r), false);
  assert.equal(isHappyHour(at('2026-11-13T17:30:00'), TZ, { ...r, enabled: false }), false);
  // 2026-11-13 is a Friday (5). Friday-only late window 23:00-01:00.
  const late = { ...r, start: '23:00', end: '01:00', days: [5] };
  assert.equal(isHappyHour(at('2026-11-13T23:30:00'), TZ, late), true);
  assert.equal(isHappyHour(at('2026-11-14T00:30:00'), TZ, late), true); // Saturday morning, Friday's window
  assert.equal(isHappyHour(at('2026-11-15T00:30:00'), TZ, late), false);
});

test('cost-plus price suggestion', () => {
  assert.equal(suggestPrice(120, 2500), 500); // $1.20 cost at 25% pour cost = $4.80 -> $5.00
  assert.equal(suggestPrice(0, 2500), 0);
});
