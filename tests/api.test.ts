import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app';
import { openDb } from '../server/db';

const TZ = 420;
const at = (isoLocal: string) => Date.parse(isoLocal + 'Z') - TZ * 60000;

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-test-'));
  const { db } = openDb(path.join(dir, 'pos.sqlite'), { managerPin: '482915' });
  const clock = { t: at('2026-11-13T20:00:00') }; // Friday night, after happy hour
  const server = createApp({ db, dataDir: dir, now: () => clock.t }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (token: string | null) => async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  const mgr = call((await call(null)('POST', '/api/login', { pin: '482915' })).body.token);
  return { dir, db, clock, server, call, mgr };
}

test('a full night on the till', async (t) => {
  const { dir, db, clock, server, call, mgr } = await boot();
  t.after(() => { server.close(); db.close(); });

  assert.equal((await call(null)('GET', '/api/bootstrap')).status, 401);
  assert.equal((await call(null)('POST', '/api/login', { pin: '0000' })).status, 401);

  assert.equal((await mgr('POST', '/api/staff', { name: 'Bartender A', role: 'bartender', pin: '482915' })).status, 400, 'duplicate PIN refused');
  assert.equal((await mgr('POST', '/api/staff', { name: 'Bartender A', role: 'bartender', pin: '7731' })).status, 200);
  const bar = call((await call(null)('POST', '/api/login', { pin: '7731' })).body.token);

  const boot1 = (await bar('GET', '/api/bootstrap')).body;
  const byName = (n: string) => boot1.products.find((p: any) => p.name === n);
  const gt = byName('Gin & Tonic'), angkor = byName('Angkor can');
  assert.equal(boot1.happy_hour, false);

  assert.equal((await bar('POST', '/api/orders', { lines: [{ product_id: gt.id, qty: 1 }], payments: [] })).status, 409, 'no selling before a shift is open');
  assert.equal((await bar('POST', '/api/shifts/open', { float_usd_cents: 5000, float_khr: 100000 })).status, 200);

  const stock0 = Object.fromEntries((await mgr('GET', '/api/stock')).body.items.map((i: any) => [i.name, i.qty]));

  // Sale 1: 2 G&T ($11.00) paid with a $20 note -> $9.00 change.
  const s1 = await bar('POST', '/api/orders', { lines: [{ product_id: gt.id, qty: 2 }], payments: [{ method: 'cash', tendered_usd_cents: 2000 }] });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.order.total_cents, 1100);
  assert.equal(s1.body.order.status, 'paid');
  assert.equal(s1.body.payments[0].change_usd_cents, 900);

  // Sale 2: 3 Angkor ($4.50) paid in riel: 18,500 due; customer hands 20,000 -> change 37c = 1,500 riel.
  const s2 = await bar('POST', '/api/orders', { lines: [{ product_id: angkor.id, qty: 3 }], payments: [{ method: 'cash', tendered_khr: 20000 }] });
  assert.equal(s2.body.order.total_cents, 450);
  assert.deepEqual([s2.body.payments[0].change_usd_cents, s2.body.payments[0].change_khr], [0, 1500]);

  // Underpayment is refused and leaves nothing behind.
  const short = await bar('POST', '/api/orders', { lines: [{ product_id: gt.id, qty: 1 }], payments: [{ method: 'cash', tendered_usd_cents: 500 }] });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /Short by \$0\.50/);

  // Tab: open, add a round, manager voids one line, split KHQR + cash.
  const tab = await bar('POST', '/api/orders', { tab_name: 'Table 4', lines: [{ product_id: gt.id, qty: 1 }] });
  assert.equal(tab.body.order.status, 'open');
  const id = tab.body.order.id;
  const more = await bar('POST', `/api/orders/${id}/lines`, { lines: [{ product_id: angkor.id, qty: 2 }, { product_id: gt.id, qty: 1 }] });
  assert.equal(more.body.order.total_cents, 550 + 300 + 550);
  const lineToVoid = more.body.lines[2].id;
  assert.equal((await bar('POST', `/api/orders/${id}/lines/${lineToVoid}/void`, { reason: 'rung twice' })).status, 403, 'bartender alone cannot void');
  assert.equal((await bar('POST', `/api/orders/${id}/lines/${lineToVoid}/void`, { reason: 'rung twice', manager_pin: '1111' })).status, 403);
  const voided = await bar('POST', `/api/orders/${id}/lines/${lineToVoid}/void`, { reason: 'rung twice', manager_pin: '482915' });
  assert.equal(voided.body.order.total_cents, 850);
  assert.equal((await bar('POST', `/api/orders/${id}/discount`, { bp: 1000, reason: 'regular' })).status, 403);
  const disc = await mgr('POST', `/api/orders/${id}/discount`, { bp: 1000, reason: 'regular' });
  assert.equal(disc.body.order.total_cents, 765);
  assert.equal((await bar('POST', '/api/shifts/close', { counted_usd_cents: 0, counted_khr: 0 })).status, 409, 'cannot close with a tab open');
  const paid = await bar('POST', `/api/orders/${id}/pay`, { payments: [{ method: 'khqr', amount_cents: 500, reference: 'ABA 1234' }, { method: 'cash', tendered_usd_cents: 300 }] });
  assert.equal(paid.body.order.status, 'paid');
  const cash = paid.body.payments.find((p: any) => p.method === 'cash');
  assert.equal(cash.amount_cents, 265);
  assert.deepEqual([cash.change_usd_cents, cash.change_khr], [0, 1400]); // 35c = 1,435 -> 1,400

  // A mistaken sale is voided by the manager and its stock comes back.
  const oops = await bar('POST', '/api/orders', { lines: [{ product_id: angkor.id, qty: 10 }], payments: [{ method: 'card', amount_cents: 1500 }] });
  assert.equal((await mgr('POST', `/api/orders/${oops.body.order.id}/void`, { reason: 'wrong card amount' })).body.order.status, 'void');

  // Stock: 3 G&T poured (one voided and restocked), 5 Angkor sold.
  const stock1 = Object.fromEntries((await mgr('GET', '/api/stock')).body.items.map((i: any) => [i.name, i.qty]));
  assert.equal(stock0['Gin'] - stock1['Gin'], 150);
  assert.equal(stock0['Tonic water'] - stock1['Tonic water'], 3);
  assert.equal(stock0['Angkor can'] - stock1['Angkor can'], 5);

  // Cash out for ice, then a blind close.
  assert.equal((await bar('POST', '/api/shifts/cash', { type: 'payout', currency: 'KHR', amount: 8000, note: 'ice' })).status, 200);
  const blind = (await bar('GET', '/api/shifts/current')).body;
  assert.equal(blind.expected_usd_cents, undefined, 'bartender does not see the expected drawer');
  const seen = (await mgr('GET', '/api/shifts/current')).body;
  // USD: 5000 float + 2000 - 900 + 300 = 6400. KHR: 100000 + 20000 - 1500 - 1400 - 8000 = 109100.
  assert.equal(seen.expected_usd_cents, 6400);
  assert.equal(seen.expected_khr, 109100);
  const z = await bar('POST', '/api/shifts/close', { counted_usd_cents: 6400, counted_khr: 108000 });
  assert.equal(z.status, 200);
  assert.deepEqual([z.body.variance_usd_cents, z.body.variance_khr], [0, -1100]);
  assert.equal(z.body.sales.net_cents, 1100 + 450 + 765);

  // Reports and the OIS drop.
  const sum = (await mgr('GET', '/api/reports/summary?from=2026-11-13&to=2026-11-13')).body;
  assert.equal(sum.orders, 3);
  assert.equal(sum.net_cents, 2315);
  assert.equal(sum.items, 2 + 3 + 1 + 2);
  assert.equal(sum.voids.orders, 1);
  assert.deepEqual(sum.by_method.map((m: any) => [m.method, m.amount_cents]), [['cash', 1100 + 450 + 265], ['khqr', 500]]);
  assert.equal((await bar('GET', '/api/reports/summary')).status, 403);

  const exp = await mgr('POST', '/api/ois/export', { date: '2026-11-13' });
  assert.equal(exp.status, 200);
  for (const f of exp.body.files) {
    const bytes = fs.readFileSync(path.join(dir, 'ois-exports', f.name));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), f.sha256);
    assert.ok(fs.readFileSync(path.join(dir, 'ois-exports', f.name + '.sha256'), 'utf8').startsWith(f.sha256));
  }
  const csv = fs.readFileSync(path.join(dir, 'ois-exports', exp.body.files[0].name), 'utf8');
  assert.equal(csv.trim().split('\r\n').length, 1 + 4, 'header + one row per item line sold');
  assert.ok(!csv.includes('Table 4'), 'tab names never leave the till');
  const daily = JSON.parse(fs.readFileSync(path.join(dir, 'ois-exports', exp.body.files[1].name), 'utf8'));
  assert.equal(daily.metrics.pos_net_sales, 23.15);
  assert.equal(daily.metrics.orders_walkin, 3);
  const again = await mgr('POST', '/api/ois/export', { date: '2026-11-13' });
  assert.deepEqual(again.body.files, exp.body.files, 'same day exports byte-identically');

  // A new shift the next evening falls in happy hour: cocktails 20% off, beer cans not.
  clock.t = at('2026-11-14T17:30:00');
  assert.equal((await bar('GET', '/api/bootstrap')).status, 401, 'yesterday\'s login has expired');
  const mgr2 = call((await call(null)('POST', '/api/login', { pin: '482915' })).body.token);
  await mgr2('POST', '/api/shifts/open', {});
  const hh = await mgr2('POST', '/api/orders', { lines: [{ product_id: gt.id, qty: 1 }, { product_id: angkor.id, qty: 1 }], payments: [{ method: 'khqr', amount_cents: 590 }] });
  assert.equal(hh.body.order.total_cents, 440 + 150);
  assert.equal((await mgr2('POST', '/api/ois/export', { date: '2026-11-14' })).status, 409, 'open day is not exported');
  assert.equal((await mgr2('POST', `/api/orders/${s1.body.order.id}/void`, { reason: 'late' })).status, 409, 'previous shift is sealed');
});

test('receipt goes to a network printer with a drawer kick', async (t) => {
  const { db, server, call, mgr } = await boot();
  const got: Buffer[] = [];
  const printer = net.createServer((s) => s.on('data', (d) => got.push(d))).listen(0, '127.0.0.1');
  await new Promise((r) => printer.once('listening', r));
  t.after(() => { server.close(); printer.close(); db.close(); });
  void call;
  await mgr('PUT', '/api/settings', { print_mode: 'network', printer_host: '127.0.0.1', printer_port: (printer.address() as AddressInfo).port });
  await mgr('POST', '/api/shifts/open', {});
  const p = (await mgr('GET', '/api/bootstrap')).body.products[0];
  const o = await mgr('POST', '/api/orders', { lines: [{ product_id: p.id, qty: 2 }], payments: [{ method: 'cash', tendered_usd_cents: 500 }] });
  const pr = await mgr('POST', `/api/orders/${o.body.order.id}/print`, { open_drawer: true });
  assert.equal(pr.body.printed, true);
  await new Promise((r) => setTimeout(r, 50));
  const bytes = Buffer.concat(got);
  assert.ok(bytes.includes(Buffer.from('DISTORTION DIVE BAR')));
  assert.ok(bytes.includes(Buffer.from('TOTAL (KHR)')));
  assert.ok(bytes.subarray(-5).equals(Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])), 'ends with drawer kick');
  assert.equal((await mgr('PUT', '/api/settings', { khr_rate: 5 })).status, 400);
});

test('wrong PINs lock the keypad', async (t) => {
  const { db, server, call } = await boot();
  t.after(() => { server.close(); db.close(); });
  for (let i = 0; i < 5; i++) assert.equal((await call(null)('POST', '/api/login', { pin: '1234' })).status, 401);
  assert.equal((await call(null)('POST', '/api/login', { pin: '482915' })).status, 429);
});
