import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

// SQLite through Node's built-in driver: one file on the till, no native build
// step on the Windows terminal, and it keeps working when the internet is down.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('manager','bartender')),
  pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS stock_items (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_km TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0, min_qty REAL NOT NULL DEFAULT 0, cost_cents REAL NOT NULL DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
  delta REAL NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('sale','void','stock_in','waste','count')),
  ref TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', unit_cost_cents REAL NOT NULL DEFAULT 0,
  staff_id INTEGER REFERENCES staff(id));
CREATE INDEX IF NOT EXISTS stock_moves_item ON stock_moves(stock_item_id, ts);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_km TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL REFERENCES categories(id), name TEXT NOT NULL,
  name_km TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL, happy_hour INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS recipe_lines (
  product_id INTEGER NOT NULL REFERENCES products(id), stock_item_id INTEGER NOT NULL REFERENCES stock_items(id),
  qty REAL NOT NULL, PRIMARY KEY (product_id, stock_item_id));
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY, business_date TEXT NOT NULL, opened_at INTEGER NOT NULL, opened_by INTEGER NOT NULL REFERENCES staff(id),
  float_usd_cents INTEGER NOT NULL DEFAULT 0, float_khr INTEGER NOT NULL DEFAULT 0, khr_rate INTEGER NOT NULL,
  closed_at INTEGER, closed_by INTEGER REFERENCES staff(id),
  counted_usd_cents INTEGER, counted_khr INTEGER, expected_usd_cents INTEGER, expected_khr INTEGER);
CREATE TABLE IF NOT EXISTS cash_moves (
  id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES shifts(id), ts INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('payin','payout','drop')), currency TEXT NOT NULL CHECK (currency IN ('USD','KHR')),
  amount INTEGER NOT NULL CHECK (amount > 0), note TEXT NOT NULL DEFAULT '', staff_id INTEGER NOT NULL REFERENCES staff(id));
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES shifts(id), business_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','paid','void')), tab_name TEXT NOT NULL DEFAULT '',
  opened_at INTEGER NOT NULL, closed_at INTEGER, staff_id INTEGER NOT NULL REFERENCES staff(id),
  discount_bp INTEGER NOT NULL DEFAULT 0, discount_reason TEXT NOT NULL DEFAULT '',
  subtotal_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0, total_cents INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT NOT NULL DEFAULT '', voided_by INTEGER REFERENCES staff(id));
CREATE INDEX IF NOT EXISTS orders_date ON orders(business_date, status);
CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL, name_km TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL CHECK (qty > 0),
  list_price_cents INTEGER NOT NULL, unit_price_cents INTEGER NOT NULL, happy_hour INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, staff_id INTEGER NOT NULL REFERENCES staff(id),
  voided INTEGER NOT NULL DEFAULT 0, void_reason TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS order_lines_order ON order_lines(order_id);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), ts INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','khqr','card')), amount_cents INTEGER NOT NULL,
  tendered_usd_cents INTEGER NOT NULL DEFAULT 0, tendered_khr INTEGER NOT NULL DEFAULT 0,
  change_usd_cents INTEGER NOT NULL DEFAULT 0, change_khr INTEGER NOT NULL DEFAULT 0,
  reference TEXT NOT NULL DEFAULT '', khr_rate INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, staff_id INTEGER, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
`;

export const DEFAULT_SETTINGS: Record<string, string> = {
  venue_name: 'Distortion Dive Bar',
  venue_address: 'St 450, Toul Tom Poung, Phnom Penh',
  receipt_footer: 'Thank you! Arkoun!',
  khr_rate: '4100',
  vat_bp: '0',
  hh_enabled: '1',
  hh_start: '17:00',
  hh_end: '19:00',
  hh_days: '0,1,2,3,4,5,6',
  hh_discount_bp: '2000',
  day_cutoff_hour: '6',
  tz_offset_min: '420',
  target_pour_cost_bp: '2500',
  receipt_cols: '42',
  print_mode: 'browser', // 'browser' | 'network' | 'off'
  printer_host: '',
  printer_port: '9100',
  ois_source_id: 'bar_pos',
};

export type Db = DatabaseSync;

export function hashPin(pin: string, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pin, salt, 32).toString('hex') };
}

export function pinMatches(pin: string, salt: string, hash: string): boolean {
  const a = Buffer.from(hashPin(pin, salt).hash, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Sample drinks list so the till is usable on first run. Prices and costs are
// placeholders in the usual Phnom Penh range: replace them in Menu and Stock.
function seedSample(db: Db) {
  const sup = db.prepare('INSERT INTO suppliers (name, contact, notes) VALUES (?,?,?)');
  const drinks = Number(sup.run('Drinks wholesaler', '', 'Spirits, beer, mixers').lastInsertRowid);
  const market = Number(sup.run('Local market', '', 'Limes, mint, ice').lastInsertRowid);
  const st = db.prepare('INSERT INTO stock_items (name, name_km, unit, qty, min_qty, cost_cents, supplier_id) VALUES (?,?,?,?,?,?,?)');
  const s = (n: string, km: string, unit: string, qty: number, min: number, cost: number, sp: number) =>
    Number(st.run(n, km, unit, qty, min, cost, sp).lastInsertRowid);
  const gin = s('Gin', 'ហ្ស៊ីន', 'ml', 2100, 700, 3, drinks);
  const vodka = s('Vodka', '', 'ml', 2100, 700, 2.2, drinks);
  const rum = s('White rum', '', 'ml', 1400, 700, 2.4, drinks);
  const whisky = s('Whiskey', '', 'ml', 1400, 700, 3.5, drinks);
  const tonic = s('Tonic water', 'ទឹកតូនិក', 'can', 24, 12, 60, drinks);
  const soda = s('Soda water', '', 'can', 24, 12, 35, drinks);
  const cola = s('Cola', '', 'can', 24, 12, 45, drinks);
  const lime = s('Lime', 'ក្រូចឆ្មារ', 'piece', 40, 10, 10, market);
  const mint = s('Mint', '', 'bunch', 6, 2, 50, market);
  const angkor = s('Angkor can', 'ស្រាបៀរអង្គរ', 'can', 96, 24, 60, drinks);
  const cambodia = s('Cambodia can', '', 'can', 96, 24, 60, drinks);
  const draft = s('Draft beer keg', '', 'ml', 30000, 10000, 0.15, drinks);
  const water = s('Water 500ml', '', 'bottle', 48, 12, 15, drinks);

  const cat = db.prepare('INSERT INTO categories (name, name_km, sort) VALUES (?,?,?)');
  const c = (n: string, km: string, i: number) => Number(cat.run(n, km, i).lastInsertRowid);
  const beer = c('Beer', 'ស្រាបៀរ', 1), cocktails = c('Cocktails', 'ស្រាក្រឡុក', 2);
  const spirits = c('Spirits', '', 3), soft = c('Soft', '', 4);
  const pr = db.prepare('INSERT INTO products (category_id, name, name_km, price_cents, happy_hour, sort) VALUES (?,?,?,?,?,?)');
  const rl = db.prepare('INSERT INTO recipe_lines (product_id, stock_item_id, qty) VALUES (?,?,?)');
  let sort = 0;
  const p = (cid: number, n: string, km: string, price: number, hh: number, recipe: [number, number][]) => {
    const id = Number(pr.run(cid, n, km, price, hh, ++sort).lastInsertRowid);
    for (const [sid, q] of recipe) rl.run(id, sid, q);
  };
  p(beer, 'Angkor can', 'ស្រាបៀរអង្គរ', 150, 0, [[angkor, 1]]);
  p(beer, 'Cambodia can', '', 150, 0, [[cambodia, 1]]);
  p(beer, 'Draft beer', '', 100, 1, [[draft, 330]]);
  p(cocktails, 'Gin & Tonic', 'ហ្ស៊ីនតូនិក', 550, 1, [[gin, 50], [tonic, 1], [lime, 0.5]]);
  p(cocktails, 'Mojito', '', 500, 1, [[rum, 50], [soda, 0.5], [lime, 1], [mint, 0.2]]);
  p(cocktails, 'Vodka Soda', '', 450, 1, [[vodka, 50], [soda, 1], [lime, 0.5]]);
  p(cocktails, 'Whiskey Cola', '', 450, 1, [[whisky, 50], [cola, 1]]);
  p(spirits, 'Gin shot', '', 300, 0, [[gin, 30]]);
  p(spirits, 'Vodka shot', '', 250, 0, [[vodka, 30]]);
  p(spirits, 'Whiskey shot', '', 300, 0, [[whisky, 30]]);
  p(soft, 'Cola', '', 150, 0, [[cola, 1]]);
  p(soft, 'Soda water', '', 100, 0, [[soda, 1]]);
  p(soft, 'Water', '', 50, 0, [[water, 1]]);
}

export function openDb(file: string, opts: { managerPin?: string; seed?: boolean } = {}): { db: Db; initialPin?: string } {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  let initialPin: string | undefined;
  const n = (db.prepare('SELECT COUNT(*) n FROM staff').get() as any).n;
  if (n === 0) {
    initialPin = opts.managerPin || String(crypto.randomInt(100000, 1000000));
    const { salt, hash } = hashPin(initialPin);
    db.prepare("INSERT INTO staff (name, role, pin_salt, pin_hash) VALUES ('Manager','manager',?,?)").run(salt, hash);
    if (opts.seed !== false) tx(db, () => seedSample(db));
  }
  return { db, initialPin };
}
