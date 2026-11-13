import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_SETTINGS, hashPin, pinMatches, tx, type Db } from './db';
import { businessDate, cashChange, discounted, isHappyHour, khrToCents, pct, suggestPrice } from './money';
import { escposJob, receiptText, sendToPrinter } from './receipt';
import { salesLinesCsv, salesSummary, toCsv, writeOisExport } from './reports';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const bad = (m: string, status = 400) => new HttpError(status, m);
const int = (v: unknown, name: string, min = 0) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw bad(`${name} must be a whole number of at least ${min}`);
  return v;
};
const num = (v: unknown, name: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${name} must be a number`);
  return v;
};
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createApp(opts: { db: Db; dataDir: string; now?: () => number }) {
  const { db, dataDir } = opts;
  const now = opts.now ?? Date.now;
  const app = express();
  app.use(express.json({ limit: '200kb' }));

  const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
  const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
  const settings = (): Record<string, string> => Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  const cfg = () => {
    const s = settings();
    return {
      s,
      rate: Number(s.khr_rate),
      tz: Number(s.tz_offset_min),
      cutoff: Number(s.day_cutoff_hour),
      hh: { enabled: s.hh_enabled === '1', start: s.hh_start, end: s.hh_end, days: s.hh_days.split(',').filter(Boolean).map(Number), discount_bp: Number(s.hh_discount_bp) },
    };
  };
  const audit = (staffId: number | null, action: string, detail: object = {}) =>
    run('INSERT INTO audit_log (ts, staff_id, action, detail) VALUES (?,?,?,?)', now(), staffId, action, JSON.stringify(detail));

  // ---- Sessions and PINs ---------------------------------------------------
  const sessions = new Map<string, { staffId: number; exp: number }>();
  const SESSION_MS = 16 * 3600 * 1000;
  let failures = 0, lockedUntil = 0;

  const staffByPin = (pin: unknown) => {
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) return null;
    return all('SELECT * FROM staff WHERE active = 1').find((s) => pinMatches(pin, s.pin_salt, s.pin_hash)) ?? null;
  };
  /** PIN check with a lockout, so a till left unattended cannot be brute-forced. */
  const checkPin = (pin: unknown) => {
    if (now() < lockedUntil) throw bad('Too many wrong PINs. Wait 30 seconds.', 429);
    const s = staffByPin(pin);
    if (!s) {
      if (++failures >= 5) { lockedUntil = now() + 30000; failures = 0; }
      audit(null, 'pin.failed');
      return null;
    }
    failures = 0;
    return s;
  };
  /** A manager is logged in, or a manager has typed their PIN on this till to approve the action. */
  const approver = (req: Request): number => {
    const me = (req as any).staff;
    if (me.role === 'manager') return me.id;
    if (req.body?.manager_pin == null) throw bad('Manager approval needed', 403);
    const m = checkPin(req.body.manager_pin);
    if (!m || m.role !== 'manager') throw bad('Manager PIN not recognised', 403);
    return m.id;
  };
  const managerOnly = (req: Request) => { if ((req as any).staff.role !== 'manager') throw bad('Managers only', 403); };

  const h = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
    } catch (e: any) {
      if (!(e instanceof HttpError)) console.error(e);
      res.status(e instanceof HttpError ? e.status : 500).json({ error: e instanceof HttpError ? e.message : 'Server error' });
    }
  };

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.post('/api/login', h((req) => {
    const s = checkPin(req.body?.pin);
    if (!s) throw bad('Wrong PIN', 401);
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { staffId: s.id, exp: now() + SESSION_MS });
    audit(s.id, 'login');
    return { token, staff: { id: s.id, name: s.name, role: s.role } };
  }));

  app.use('/api', (req, res, next) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const sess = sessions.get(token);
    const staff = sess && sess.exp > now() ? one('SELECT id, name, role FROM staff WHERE id = ? AND active = 1', sess.staffId) : null;
    if (!staff) { res.status(401).json({ error: 'Not logged in' }); return; }
    (req as any).staff = staff;
    (req as any).token = token;
    next();
  });
  app.post('/api/logout', h((req) => { sessions.delete((req as any).token); }));

  // ---- Shared order and stock logic ----------------------------------------
  const openShift = () => one('SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
  const needShift = () => { const s = openShift(); if (!s) throw bad('Open a shift first', 409); return s; };

  const moveStock = (itemId: number, delta: number, reason: string, ref: string, staffId: number, note = '', unitCost = 0) => {
    run('UPDATE stock_items SET qty = qty + ? WHERE id = ?', delta, itemId);
    run('INSERT INTO stock_moves (ts, stock_item_id, delta, reason, ref, note, unit_cost_cents, staff_id) VALUES (?,?,?,?,?,?,?,?)',
      now(), itemId, delta, reason, ref, note, unitCost, staffId);
  };
  const recalc = (orderId: number) => {
    const o = one('SELECT discount_bp FROM orders WHERE id = ?', orderId);
    const sub = one('SELECT COALESCE(SUM(unit_price_cents * qty), 0) v FROM order_lines WHERE order_id = ? AND voided = 0', orderId).v;
    const disc = pct(sub, o.discount_bp);
    run('UPDATE orders SET subtotal_cents = ?, discount_cents = ?, total_cents = ? WHERE id = ?', sub, disc, sub - disc, orderId);
  };
  const orderView = (id: number) => {
    const order = one('SELECT o.*, s.name staff_name FROM orders o JOIN staff s ON s.id = o.staff_id WHERE o.id = ?', id);
    if (!order) throw bad('Order not found', 404);
    return { order, lines: all('SELECT * FROM order_lines WHERE order_id = ? ORDER BY id', id), payments: all('SELECT * FROM payments WHERE order_id = ? ORDER BY id', id) };
  };
  /** Price is fixed and stock leaves the shelf at the moment a drink is rung up, not when the tab is paid. */
  const addLines = (orderId: number, lines: unknown, staffId: number) => {
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > 100) throw bad('No items');
    const c = cfg();
    const hhNow = isHappyHour(now(), c.tz, c.hh);
    for (const raw of lines) {
      const qty = int(raw?.qty, 'qty', 1);
      const p = one('SELECT p.*, c.name category FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ? AND p.active = 1', raw?.product_id);
      if (!p) throw bad('Item is not on the menu');
      const recipe = all('SELECT r.stock_item_id, r.qty, s.cost_cents FROM recipe_lines r JOIN stock_items s ON s.id = r.stock_item_id WHERE r.product_id = ?', p.id);
      const hh = hhNow && p.happy_hour === 1;
      const unit = hh ? discounted(p.price_cents, c.hh.discount_bp) : p.price_cents;
      const cost = Math.round(recipe.reduce((a, r) => a + r.qty * r.cost_cents, 0));
      const lineId = Number(run(`INSERT INTO order_lines (order_id, product_id, name, name_km, category, qty, list_price_cents, unit_price_cents, happy_hour, cost_cents, added_at, staff_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, orderId, p.id, p.name, p.name_km, p.category, qty, p.price_cents, unit, hh ? 1 : 0, cost, now(), staffId).lastInsertRowid);
      for (const r of recipe) moveStock(r.stock_item_id, -r.qty * qty, 'sale', `line:${lineId}`, staffId, '', r.cost_cents);
    }
    recalc(orderId);
  };
  const restockLine = (lineId: number, staffId: number) => {
    for (const m of all("SELECT stock_item_id, SUM(delta) d FROM stock_moves WHERE ref = ? GROUP BY stock_item_id HAVING d != 0", `line:${lineId}`)) {
      moveStock(m.stock_item_id, -m.d, 'void', `line:${lineId}`, staffId);
    }
  };
  const settle = (orderId: number, payments: unknown, staffId: number) => {
    const o = one('SELECT * FROM orders WHERE id = ?', orderId);
    if (o.status !== 'open') throw bad('Order is already closed', 409);
    if (!one('SELECT 1 x FROM order_lines WHERE order_id = ? AND voided = 0', orderId)) throw bad('Nothing to pay for');
    const { rate } = cfg();
    const list = Array.isArray(payments) ? payments : [];
    let remaining = o.total_cents;
    let cashUsd = 0, cashKhr = 0;
    const rows: any[] = [];
    for (const p of list) {
      if (p?.method === 'cash') {
        cashUsd += int(p.tendered_usd_cents ?? 0, 'cash USD');
        cashKhr += int(p.tendered_khr ?? 0, 'cash KHR');
      } else if (p?.method === 'khqr' || p?.method === 'card') {
        const amt = int(p.amount_cents, 'amount', 1);
        if (amt > remaining) throw bad('Card/KHQR amount is more than the bill');
        remaining -= amt;
        rows.push({ method: p.method, amount: amt, reference: str(p.reference, 60) });
      } else throw bad('Unknown payment method');
    }
    const cashValue = cashUsd + khrToCents(cashKhr, rate);
    if (remaining === 0 && cashValue > 0) throw bad('Bill is already covered: remove the cash');
    if (cashValue < remaining) throw bad(`Short by $${((remaining - cashValue) / 100).toFixed(2)}`);
    for (const r of rows) run('INSERT INTO payments (order_id, ts, method, amount_cents, reference, khr_rate) VALUES (?,?,?,?,?,?)', orderId, now(), r.method, r.amount, r.reference, rate);
    if (remaining > 0) {
      const ch = cashChange(cashValue - remaining, rate);
      run(`INSERT INTO payments (order_id, ts, method, amount_cents, tendered_usd_cents, tendered_khr, change_usd_cents, change_khr, khr_rate)
        VALUES (?,?,'cash',?,?,?,?,?,?)`, orderId, now(), remaining, cashUsd, cashKhr, ch.change_usd_cents, ch.change_khr, rate);
    }
    run("UPDATE orders SET status = 'paid', closed_at = ? WHERE id = ?", now(), orderId);
    audit(staffId, 'order.paid', { order: orderId, total_cents: o.total_cents });
  };

  // ---- Till ----------------------------------------------------------------
  app.get('/api/bootstrap', h((req) => {
    const c = cfg();
    return {
      staff: (req as any).staff,
      settings: c.s,
      happy_hour: isHappyHour(now(), c.tz, c.hh),
      shift: openShift() ?? null,
      categories: all('SELECT * FROM categories ORDER BY sort, id'),
      products: all('SELECT id, category_id, name, name_km, price_cents, happy_hour FROM products WHERE active = 1 ORDER BY sort, id'),
      open_tabs: all("SELECT id, tab_name, total_cents, opened_at FROM orders WHERE status = 'open' ORDER BY id"),
      low_stock: one('SELECT COUNT(*) n FROM stock_items WHERE active = 1 AND qty <= min_qty').n,
    };
  }));

  app.post('/api/orders', h((req) => {
    const me = (req as any).staff;
    const shift = needShift();
    const pay = req.body?.payments;
    const tab = str(req.body?.tab_name, 40);
    if (!pay && !tab) throw bad('A tab needs a name');
    const id = tx(db, () => {
      const oid = Number(run("INSERT INTO orders (shift_id, business_date, status, tab_name, opened_at, staff_id) VALUES (?,?,'open',?,?,?)",
        shift.id, shift.business_date, tab, now(), me.id).lastInsertRowid);
      addLines(oid, req.body?.lines, me.id);
      if (pay) settle(oid, pay, me.id);
      else audit(me.id, 'tab.opened', { order: oid });
      return oid;
    });
    return orderView(id);
  }));
  app.get('/api/orders', h((req) => {
    const shift = openShift();
    const status = str(req.query.status);
    if (status === 'open') return all("SELECT id, tab_name, total_cents, opened_at, status FROM orders WHERE status = 'open' ORDER BY id");
    return all(`SELECT o.id, o.tab_name, o.total_cents, o.status, o.opened_at, o.closed_at, s.name staff_name FROM orders o
      JOIN staff s ON s.id = o.staff_id WHERE o.shift_id = ? ORDER BY o.id DESC LIMIT 300`, shift?.id ?? -1);
  }));
  app.get('/api/orders/:id', h((req) => orderView(Number(req.params.id))));
  const openOrder = (req: Request) => {
    const o = one('SELECT * FROM orders WHERE id = ?', Number(req.params.id));
    if (!o) throw bad('Order not found', 404);
    if (o.status !== 'open') throw bad('Order is already closed', 409);
    return o;
  };
  app.post('/api/orders/:id/lines', h((req) => {
    const o = openOrder(req); needShift();
    tx(db, () => addLines(o.id, req.body?.lines, (req as any).staff.id));
    return orderView(o.id);
  }));
  // Taking a drink off a saved tab is the classic way a till gets skimmed, so it needs a manager and a reason.
  app.post('/api/orders/:id/lines/:lineId/void', h((req) => {
    const o = openOrder(req);
    const by = approver(req);
    const reason = str(req.body?.reason);
    if (!reason) throw bad('Give a reason');
    const line = one('SELECT * FROM order_lines WHERE id = ? AND order_id = ? AND voided = 0', Number(req.params.lineId), o.id);
    if (!line) throw bad('Line not found', 404);
    tx(db, () => {
      run('UPDATE order_lines SET voided = 1, void_reason = ? WHERE id = ?', reason, line.id);
      if (req.body?.restock !== false) restockLine(line.id, by);
      recalc(o.id);
      audit(by, 'line.voided', { order: o.id, line: line.id, name: line.name, qty: line.qty, reason, restock: req.body?.restock !== false, requested_by: (req as any).staff.id });
    });
    return orderView(o.id);
  }));
  app.post('/api/orders/:id/discount', h((req) => {
    const o = openOrder(req);
    const by = approver(req);
    const bp = int(req.body?.bp, 'discount');
    if (bp > 10000) throw bad('Discount cannot exceed 100%');
    const reason = str(req.body?.reason);
    if (bp > 0 && !reason) throw bad('Give a reason');
    tx(db, () => {
      run('UPDATE orders SET discount_bp = ?, discount_reason = ? WHERE id = ?', bp, reason, o.id);
      recalc(o.id);
      audit(by, 'order.discount', { order: o.id, bp, reason });
    });
    return orderView(o.id);
  }));
  app.post('/api/orders/:id/pay', h((req) => {
    const o = openOrder(req);
    if (o.shift_id !== needShift().id) throw bad('Tab belongs to a closed shift', 409);
    tx(db, () => settle(o.id, req.body?.payments, (req as any).staff.id));
    return orderView(o.id);
  }));
  app.post('/api/orders/:id/void', h((req) => {
    const o = one('SELECT * FROM orders WHERE id = ?', Number(req.params.id));
    if (!o) throw bad('Order not found', 404);
    if (o.status === 'void') throw bad('Already voided', 409);
    const shift = openShift();
    if (!shift || shift.id !== o.shift_id) throw bad('Only orders from the current shift can be voided. Record a later refund as a cash payout.', 409);
    const by = approver(req);
    const reason = str(req.body?.reason);
    if (!reason) throw bad('Give a reason');
    tx(db, () => {
      if (req.body?.restock !== false) for (const l of all('SELECT id FROM order_lines WHERE order_id = ? AND voided = 0', o.id)) restockLine(l.id, by);
      run("UPDATE orders SET status = 'void', void_reason = ?, voided_by = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?", reason, by, now(), o.id);
      audit(by, 'order.voided', { order: o.id, was: o.status, total_cents: o.total_cents, reason, restock: req.body?.restock !== false, requested_by: (req as any).staff.id });
    });
    return orderView(o.id);
  }));

  const receiptFor = (id: number) => {
    const v = orderView(id);
    const c = cfg();
    const t = new Date((v.order.closed_at ?? v.order.opened_at) + c.tz * 60000).toISOString();
    return receiptText({ settings: c.s, order: v.order, lines: v.lines.filter((l) => !l.voided), payments: v.payments, staffName: v.order.staff_name, localTime: `${t.slice(0, 10)} ${t.slice(11, 16)}` });
  };
  const printer = () => { const s = settings(); return s.print_mode === 'network' && s.printer_host ? { host: s.printer_host, port: Number(s.printer_port) || 9100 } : null; };
  app.post('/api/orders/:id/print', h(async (req) => {
    const text = receiptFor(Number(req.params.id));
    const p = printer();
    if (!p) return { text, printed: false };
    try {
      await sendToPrinter(p.host, p.port, escposJob(text, req.body?.open_drawer === true));
      return { text, printed: true };
    } catch (e: any) {
      return { text, printed: false, printer_error: String(e.message ?? e) };
    }
  }));
  app.post('/api/drawer', h(async (req) => {
    const p = printer();
    if (!p) throw bad('Drawer kick needs a network receipt printer (Settings)');
    await sendToPrinter(p.host, p.port, Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])).catch((e) => { throw bad(`Printer: ${e.message}`, 502); });
    audit((req as any).staff.id, 'drawer.opened', { reason: str(req.body?.reason) });
  }));

  // ---- Shifts and cash -----------------------------------------------------
  const shiftReport = (id: number) => {
    const s = one(`SELECT sh.*, a.name opened_by_name, b.name closed_by_name FROM shifts sh
      JOIN staff a ON a.id = sh.opened_by LEFT JOIN staff b ON b.id = sh.closed_by WHERE sh.id = ?`, id);
    if (!s) throw bad('Shift not found', 404);
    const pay = all(`SELECT p.method, COUNT(*) n, SUM(p.amount_cents) amount_cents, SUM(p.tendered_usd_cents) tu, SUM(p.tendered_khr) tk,
      SUM(p.change_usd_cents) cu, SUM(p.change_khr) ck FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.shift_id = ? AND o.status = 'paid' GROUP BY p.method ORDER BY p.method`, id);
    const moves = all('SELECT m.*, s.name staff_name FROM cash_moves m JOIN staff s ON s.id = m.staff_id WHERE m.shift_id = ? ORDER BY m.id', id);
    const net = (cur: string) => moves.filter((m) => m.currency === cur).reduce((a, m) => a + (m.type === 'payin' ? m.amount : -m.amount), 0);
    const cash = pay.find((p) => p.method === 'cash') ?? { tu: 0, tk: 0, cu: 0, ck: 0 };
    const sales = one("SELECT COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) subtotal_cents, COALESCE(SUM(discount_cents),0) discount_cents, COALESCE(SUM(total_cents),0) net_cents FROM orders WHERE shift_id = ? AND status = 'paid'", id);
    const expected_usd_cents = s.float_usd_cents + cash.tu - cash.cu + net('USD');
    const expected_khr = s.float_khr + cash.tk - cash.ck + net('KHR');
    return {
      shift: s, sales, payments: pay.map(({ method, n, amount_cents }) => ({ method, payments: n, amount_cents })), cash_moves: moves,
      voids: one("SELECT COUNT(*) orders, COALESCE(SUM(total_cents),0) value_cents FROM orders WHERE shift_id = ? AND status = 'void'", id),
      open_tabs: all("SELECT id, tab_name, total_cents FROM orders WHERE shift_id = ? AND status = 'open'", id),
      expected_usd_cents, expected_khr,
      variance_usd_cents: s.counted_usd_cents == null ? null : s.counted_usd_cents - expected_usd_cents,
      variance_khr: s.counted_khr == null ? null : s.counted_khr - expected_khr,
    };
  };
  /** Bartenders count the drawer blind: they never see what the till expects until a manager does. */
  const blind = (r: any, role: string) => {
    if (role === 'manager' || r.shift.closed_at) return r;
    const { expected_usd_cents, expected_khr, variance_usd_cents, variance_khr, sales, payments, ...rest } = r;
    return rest;
  };
  app.get('/api/shifts/current', h((req) => {
    const s = openShift();
    return s ? blind(shiftReport(s.id), (req as any).staff.role) : null;
  }));
  app.post('/api/shifts/open', h((req) => {
    if (openShift()) throw bad('A shift is already open', 409);
    const c = cfg();
    const me = (req as any).staff;
    const fu = int(req.body?.float_usd_cents ?? 0, 'float USD'), fk = int(req.body?.float_khr ?? 0, 'float KHR');
    const id = Number(run('INSERT INTO shifts (business_date, opened_at, opened_by, float_usd_cents, float_khr, khr_rate) VALUES (?,?,?,?,?,?)',
      businessDate(now(), c.tz, c.cutoff), now(), me.id, fu, fk, c.rate).lastInsertRowid);
    audit(me.id, 'shift.opened', { shift: id, float_usd_cents: fu, float_khr: fk });
    return blind(shiftReport(id), me.role);
  }));
  app.post('/api/shifts/cash', h((req) => {
    const s = needShift();
    const { type, currency } = req.body ?? {};
    if (!['payin', 'payout', 'drop'].includes(type) || !['USD', 'KHR'].includes(currency)) throw bad('Bad cash movement');
    const amount = int(req.body.amount, 'amount', 1);
    const note = str(req.body.note);
    if (!note) throw bad('Say what the cash was for');
    run('INSERT INTO cash_moves (shift_id, ts, type, currency, amount, note, staff_id) VALUES (?,?,?,?,?,?,?)', s.id, now(), type, currency, amount, note, (req as any).staff.id);
    audit((req as any).staff.id, `cash.${type}`, { shift: s.id, currency, amount, note });
    return blind(shiftReport(s.id), (req as any).staff.role);
  }));
  app.post('/api/shifts/close', h((req) => {
    const s = needShift();
    const cu = int(req.body?.counted_usd_cents, 'counted USD'), ck = int(req.body?.counted_khr, 'counted KHR');
    const r = shiftReport(s.id);
    if (r.open_tabs.length) throw bad(`Settle or void open tabs first: ${r.open_tabs.map((t: any) => t.tab_name || `#${t.id}`).join(', ')}`, 409);
    run('UPDATE shifts SET closed_at = ?, closed_by = ?, counted_usd_cents = ?, counted_khr = ?, expected_usd_cents = ?, expected_khr = ? WHERE id = ?',
      now(), (req as any).staff.id, cu, ck, r.expected_usd_cents, r.expected_khr, s.id);
    audit((req as any).staff.id, 'shift.closed', { shift: s.id, variance_usd_cents: cu - r.expected_usd_cents, variance_khr: ck - r.expected_khr });
    return shiftReport(s.id);
  }));
  app.get('/api/shifts', h((req) => { managerOnly(req); return all('SELECT * FROM shifts ORDER BY id DESC LIMIT 60'); }));
  app.get('/api/shifts/:id', h((req) => { managerOnly(req); return shiftReport(Number(req.params.id)); }));

  // ---- Stock ---------------------------------------------------------------
  app.get('/api/stock', h(() => ({
    items: all('SELECT s.*, p.name supplier_name FROM stock_items s LEFT JOIN suppliers p ON p.id = s.supplier_id WHERE s.active = 1 ORDER BY s.name'),
    suppliers: all('SELECT * FROM suppliers ORDER BY name'),
  })));
  app.get('/api/stock/:id/moves', h((req) => all('SELECT m.*, s.name staff_name FROM stock_moves m LEFT JOIN staff s ON s.id = m.staff_id WHERE m.stock_item_id = ? ORDER BY m.id DESC LIMIT 100', Number(req.params.id))));
  const stockFields = (b: any) => {
    const name = str(b?.name, 80), unit = str(b?.unit, 12);
    if (!name || !unit) throw bad('Name and unit are required');
    return [name, str(b.name_km, 80), unit, num(b.min_qty ?? 0, 'minimum'), num(b.cost_cents ?? 0, 'cost'), b.supplier_id ?? null];
  };
  app.post('/api/stock', h((req) => {
    managerOnly(req);
    const id = Number(run('INSERT INTO stock_items (name, name_km, unit, min_qty, cost_cents, supplier_id) VALUES (?,?,?,?,?,?)', ...stockFields(req.body)).lastInsertRowid);
    audit((req as any).staff.id, 'stock.created', { id });
    return { id };
  }));
  app.put('/api/stock/:id', h((req) => {
    managerOnly(req);
    run('UPDATE stock_items SET name = ?, name_km = ?, unit = ?, min_qty = ?, cost_cents = ?, supplier_id = ?, active = ? WHERE id = ?', ...stockFields(req.body), req.body.active === false ? 0 : 1, Number(req.params.id));
    audit((req as any).staff.id, 'stock.edited', { id: Number(req.params.id) });
  }));
  app.post('/api/stock/in', h((req) => {
    managerOnly(req);
    const lines = req.body?.lines;
    if (!Array.isArray(lines) || !lines.length) throw bad('No lines');
    const note = str(req.body.note);
    tx(db, () => {
      for (const l of lines) {
        const item = one('SELECT * FROM stock_items WHERE id = ?', l?.stock_item_id);
        const qty = num(l?.qty, 'qty'), cost = num(l?.unit_cost_cents, 'unit cost');
        if (!item || qty <= 0 || cost < 0) throw bad('Bad stock-in line');
        // Weighted average cost, so a price rise from the supplier flows into drink costing.
        const onHand = Math.max(item.qty, 0);
        run('UPDATE stock_items SET cost_cents = ? WHERE id = ?', (onHand * item.cost_cents + qty * cost) / (onHand + qty), item.id);
        moveStock(item.id, qty, 'stock_in', str(req.body.supplier_id != null ? `supplier:${req.body.supplier_id}` : ''), (req as any).staff.id, note, cost);
      }
      audit((req as any).staff.id, 'stock.in', { lines: lines.length, note });
    });
  }));
  app.post('/api/stock/waste', h((req) => {
    const item = one('SELECT * FROM stock_items WHERE id = ?', req.body?.stock_item_id);
    const qty = num(req.body?.qty, 'qty');
    const reason = str(req.body?.reason);
    if (!item || qty <= 0) throw bad('Bad waste entry');
    if (!reason) throw bad('Give a reason');
    tx(db, () => {
      moveStock(item.id, -qty, 'waste', '', (req as any).staff.id, reason, item.cost_cents);
      audit((req as any).staff.id, 'stock.waste', { item: item.id, qty, reason });
    });
  }));
  app.post('/api/stock/count', h((req) => {
    managerOnly(req);
    const lines = req.body?.lines;
    if (!Array.isArray(lines) || !lines.length) throw bad('No lines');
    return tx(db, () => {
      const out = lines.map((l) => {
        const item = one('SELECT * FROM stock_items WHERE id = ?', l?.stock_item_id);
        const counted = num(l?.counted, 'count');
        if (!item || counted < 0) throw bad('Bad count line');
        const variance = counted - item.qty;
        if (variance !== 0) moveStock(item.id, variance, 'count', '', (req as any).staff.id, 'stocktake', item.cost_cents);
        return { stock_item_id: item.id, name: item.name, expected: item.qty, counted, variance, variance_cost_cents: Math.round(variance * item.cost_cents) };
      });
      audit((req as any).staff.id, 'stock.count', { lines: out.filter((o) => o.variance !== 0) });
      return out;
    });
  }));
  app.post('/api/suppliers', h((req) => {
    managerOnly(req);
    const name = str(req.body?.name, 80);
    if (!name) throw bad('Name is required');
    return { id: Number(run('INSERT INTO suppliers (name, contact, notes) VALUES (?,?,?)', name, str(req.body.contact, 80), str(req.body.notes, 400)).lastInsertRowid) };
  }));
  app.put('/api/suppliers/:id', h((req) => {
    managerOnly(req);
    const name = str(req.body?.name, 80);
    if (!name) throw bad('Name is required');
    run('UPDATE suppliers SET name = ?, contact = ?, notes = ? WHERE id = ?', name, str(req.body.contact, 80), str(req.body.notes, 400), Number(req.params.id));
  }));

  // ---- Menu ----------------------------------------------------------------
  app.get('/api/menu', h((req) => {
    managerOnly(req);
    const target = Number(settings().target_pour_cost_bp);
    const recipes = all('SELECT r.*, s.name, s.unit, s.cost_cents FROM recipe_lines r JOIN stock_items s ON s.id = r.stock_item_id');
    return {
      categories: all('SELECT * FROM categories ORDER BY sort, id'),
      products: all('SELECT * FROM products ORDER BY sort, id').map((p) => {
        const recipe = recipes.filter((r) => r.product_id === p.id);
        const cost = Math.round(recipe.reduce((a, r) => a + r.qty * r.cost_cents, 0));
        return { ...p, recipe: recipe.map(({ stock_item_id, qty, name, unit }) => ({ stock_item_id, qty, name, unit })), cost_cents: cost,
          pour_cost_bp: p.price_cents ? Math.round((cost * 10000) / p.price_cents) : 0, suggested_price_cents: suggestPrice(cost, target) };
      }),
    };
  }));
  app.post('/api/categories', h((req) => {
    managerOnly(req);
    const name = str(req.body?.name, 40);
    if (!name) throw bad('Name is required');
    return { id: Number(run('INSERT INTO categories (name, name_km, sort) VALUES (?,?,?)', name, str(req.body.name_km, 40), int(req.body.sort ?? 99, 'sort')).lastInsertRowid) };
  }));
  const saveProduct = (req: Request, id: number | null) => {
    managerOnly(req);
    const b = req.body ?? {};
    const name = str(b.name, 60);
    if (!name) throw bad('Name is required');
    if (!one('SELECT 1 x FROM categories WHERE id = ?', b.category_id)) throw bad('Pick a category');
    const price = int(b.price_cents, 'price');
    const recipe = Array.isArray(b.recipe) ? b.recipe : [];
    return tx(db, () => {
      const args = [b.category_id, name, str(b.name_km, 60), price, b.happy_hour ? 1 : 0, b.active === false ? 0 : 1, int(b.sort ?? 99, 'sort')];
      const pid = id ?? Number(run('INSERT INTO products (category_id, name, name_km, price_cents, happy_hour, active, sort) VALUES (?,?,?,?,?,?,?)', ...args).lastInsertRowid);
      if (id) {
        const before = one('SELECT price_cents FROM products WHERE id = ?', id);
        if (!before) throw bad('Product not found', 404);
        run('UPDATE products SET category_id = ?, name = ?, name_km = ?, price_cents = ?, happy_hour = ?, active = ?, sort = ? WHERE id = ?', ...args, id);
        if (before.price_cents !== price) audit((req as any).staff.id, 'product.price', { id, from: before.price_cents, to: price });
      }
      run('DELETE FROM recipe_lines WHERE product_id = ?', pid);
      for (const r of recipe) {
        if (!one('SELECT 1 x FROM stock_items WHERE id = ?', r?.stock_item_id) || num(r?.qty, 'recipe qty') <= 0) throw bad('Bad recipe line');
        run('INSERT OR REPLACE INTO recipe_lines (product_id, stock_item_id, qty) VALUES (?,?,?)', pid, r.stock_item_id, r.qty);
      }
      return { id: pid };
    });
  };
  app.post('/api/products', h((req) => saveProduct(req, null)));
  app.put('/api/products/:id', h((req) => saveProduct(req, Number(req.params.id))));

  // ---- Staff and settings --------------------------------------------------
  const pinFree = (pin: unknown, exceptId = 0) => {
    if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw bad('PIN must be 4 to 8 digits');
    const clash = staffByPin(pin);
    if (clash && clash.id !== exceptId) throw bad('That PIN is already in use');
    return hashPin(pin);
  };
  app.get('/api/staff', h((req) => { managerOnly(req); return all('SELECT id, name, role, active FROM staff ORDER BY active DESC, name'); }));
  app.post('/api/staff', h((req) => {
    managerOnly(req);
    const name = str(req.body?.name, 40), role = req.body?.role;
    if (!name || !['manager', 'bartender'].includes(role)) throw bad('Name and role are required');
    const { salt, hash } = pinFree(req.body.pin);
    const id = Number(run('INSERT INTO staff (name, role, pin_salt, pin_hash) VALUES (?,?,?,?)', name, role, salt, hash).lastInsertRowid);
    audit((req as any).staff.id, 'staff.created', { id, role });
    return { id };
  }));
  app.put('/api/staff/:id', h((req) => {
    managerOnly(req);
    const id = Number(req.params.id);
    const s = one('SELECT * FROM staff WHERE id = ?', id);
    if (!s) throw bad('Staff not found', 404);
    const name = str(req.body?.name, 40) || s.name;
    const role = ['manager', 'bartender'].includes(req.body?.role) ? req.body.role : s.role;
    const active = req.body?.active === undefined ? s.active : req.body.active ? 1 : 0;
    if ((role !== 'manager' || !active) && s.role === 'manager' && one("SELECT COUNT(*) n FROM staff WHERE role = 'manager' AND active = 1 AND id != ?", id).n === 0) throw bad('Keep at least one active manager');
    run('UPDATE staff SET name = ?, role = ?, active = ? WHERE id = ?', name, role, active, id);
    if (req.body?.pin) { const { salt, hash } = pinFree(req.body.pin, id); run('UPDATE staff SET pin_salt = ?, pin_hash = ? WHERE id = ?', salt, hash, id); }
    audit((req as any).staff.id, 'staff.edited', { id, role, active, pin_changed: !!req.body?.pin });
  }));
  app.put('/api/settings', h((req) => {
    managerOnly(req);
    const b = req.body ?? {};
    const numeric: Record<string, [number, number]> = { khr_rate: [1000, 10000], vat_bp: [0, 5000], hh_discount_bp: [0, 10000], day_cutoff_hour: [0, 12], tz_offset_min: [-720, 840], target_pour_cost_bp: [100, 10000], receipt_cols: [24, 64], printer_port: [1, 65535] };
    const changed: Record<string, string> = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (b[k] === undefined) continue;
      const v = String(b[k]).trim().slice(0, 200);
      if (numeric[k] && !(Number.isInteger(Number(v)) && Number(v) >= numeric[k][0] && Number(v) <= numeric[k][1])) throw bad(`${k} must be between ${numeric[k][0]} and ${numeric[k][1]}`);
      if ((k === 'hh_start' || k === 'hh_end') && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) throw bad(`${k} must be HH:MM`);
      if (k === 'hh_days' && !/^([0-6](,[0-6])*)?$/.test(v)) throw bad('hh_days must be day numbers 0-6');
      if (k === 'print_mode' && !['browser', 'network', 'off'].includes(v)) throw bad('Bad print mode');
      if (k === 'ois_source_id' && !/^[a-z0-9_]{2,40}$/.test(v)) throw bad('OIS source id: lowercase letters, digits and _ only');
      if (k === 'printer_host' && v && !/^[A-Za-z0-9.\-]+$/.test(v)) throw bad('Bad printer host');
      changed[k] = v;
    }
    tx(db, () => {
      for (const [k, v] of Object.entries(changed)) run('UPDATE settings SET value = ? WHERE key = ?', v, k);
      audit((req as any).staff.id, 'settings.changed', changed);
    });
    return settings();
  }));
  app.get('/api/audit', h((req) => { managerOnly(req); return all('SELECT a.*, s.name staff_name FROM audit_log a LEFT JOIN staff s ON s.id = a.staff_id ORDER BY a.id DESC LIMIT 300'); }));

  // ---- Reports and OIS export ----------------------------------------------
  const range = (req: Request) => {
    const c = cfg();
    const today = businessDate(now(), c.tz, c.cutoff);
    const from = str(req.query.from) || today, to = str(req.query.to) || from;
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw bad('Bad date range');
    return { from, to, tz: c.tz };
  };
  app.get('/api/reports/summary', h((req) => { managerOnly(req); const r = range(req); return salesSummary(db, r.from, r.to, r.tz); }));
  app.get('/api/reports/export.csv', h((req, res) => {
    managerOnly(req);
    const r = range(req);
    let body: string;
    if (req.query.type === 'daily') {
      const s = salesSummary(db, r.from, r.to, r.tz);
      body = toCsv(['business_date', 'orders', 'net_sales_usd'], s.by_day.map((d: any) => [d.business_date, d.orders, (d.net_cents / 100).toFixed(2)]));
    } else body = salesLinesCsv(db, r.from, r.to);
    res.type('text/csv').send(body);
  }));
  const oisDir = path.join(dataDir, 'ois-exports');
  app.post('/api/ois/export', h((req) => {
    managerOnly(req);
    const date = str(req.body?.date);
    if (!DATE.test(date)) throw bad('Pick a trading day');
    if (one('SELECT 1 x FROM shifts WHERE business_date = ? AND closed_at IS NULL', date)) throw bad('Close the shift first: an open day would export incomplete figures', 409);
    if (!one('SELECT 1 x FROM shifts WHERE business_date = ?', date)) throw bad('No shift was run on that day', 404);
    const c = cfg();
    const files = writeOisExport(db, oisDir, date, c.s.ois_source_id, c.tz);
    audit((req as any).staff.id, 'ois.export', { date, files });
    return { dir: oisDir, files };
  }));
  app.get('/api/ois/exports', h((req) => { managerOnly(req); return fs.existsSync(oisDir) ? fs.readdirSync(oisDir).filter((f) => !f.endsWith('.sha256')).sort().reverse() : []; }));
  app.get('/api/ois/exports/:name', h((req, res) => {
    managerOnly(req);
    const name = path.basename(req.params.name);
    const file = path.join(oisDir, name);
    if (!fs.existsSync(file)) throw bad('Not found', 404);
    res.type(name.endsWith('.json') ? 'application/json' : name.endsWith('.csv') ? 'text/csv' : 'text/plain').send(fs.readFileSync(file));
  }));

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });
  return app;
}
