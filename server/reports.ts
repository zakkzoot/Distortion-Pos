import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './db';
import { localParts } from './money';

// Everything in this file is SQL aggregation and string formatting. Reports and
// the OIS export are reproducible: the same sales always give the same bytes.

const all = (db: Db, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
const one = (db: Db, sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any;

/** Sales summary for a range of trading days (inclusive). Paid orders only. */
export function salesSummary(db: Db, from: string, to: string, tzOffsetMin: number) {
  const W = `o.status = 'paid' AND o.business_date BETWEEN ? AND ?`;
  const L = `FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.voided = 0 AND ${W}`;
  const totals = one(db, `SELECT COUNT(*) orders, COALESCE(SUM(subtotal_cents),0) subtotal_cents,
    COALESCE(SUM(discount_cents),0) discount_cents, COALESCE(SUM(total_cents),0) net_cents FROM orders o WHERE ${W}`, from, to);
  const lines = one(db, `SELECT COALESCE(SUM(l.qty),0) items, COALESCE(SUM(l.list_price_cents*l.qty),0) gross_cents,
    COALESCE(SUM((l.list_price_cents-l.unit_price_cents)*l.qty),0) happy_hour_cents, COALESCE(SUM(l.cost_cents*l.qty),0) cogs_cents ${L}`, from, to);
  const hours = new Map<number, { hour: number; orders: number; net_cents: number }>();
  for (const o of all(db, `SELECT closed_at, total_cents FROM orders o WHERE ${W}`, from, to)) {
    const h = localParts(o.closed_at, tzOffsetMin).hour;
    const e = hours.get(h) ?? { hour: h, orders: 0, net_cents: 0 };
    e.orders++; e.net_cents += o.total_cents; hours.set(h, e);
  }
  return {
    from, to,
    ...totals, ...lines,
    margin_cents: totals.net_cents - lines.cogs_cents,
    by_method: all(db, `SELECT p.method, COUNT(*) payments, SUM(p.amount_cents) amount_cents FROM payments p
      JOIN orders o ON o.id = p.order_id WHERE ${W} GROUP BY p.method ORDER BY p.method`, from, to),
    by_product: all(db, `SELECT l.product_id, l.name, l.category, SUM(l.qty) qty, SUM(l.unit_price_cents*l.qty) sales_cents,
      SUM(l.cost_cents*l.qty) cogs_cents ${L} GROUP BY l.product_id, l.name, l.category ORDER BY sales_cents DESC, l.name`, from, to),
    by_category: all(db, `SELECT l.category, SUM(l.qty) qty, SUM(l.unit_price_cents*l.qty) sales_cents ${L}
      GROUP BY l.category ORDER BY sales_cents DESC, l.category`, from, to),
    by_staff: all(db, `SELECT s.id staff_id, s.name, COUNT(*) orders, SUM(o.total_cents) net_cents FROM orders o
      JOIN staff s ON s.id = o.staff_id WHERE ${W} GROUP BY s.id, s.name ORDER BY net_cents DESC`, from, to),
    by_hour: [...hours.values()].sort((a, b) => a.hour - b.hour),
    by_day: all(db, `SELECT o.business_date, COUNT(*) orders, SUM(o.total_cents) net_cents FROM orders o WHERE ${W}
      GROUP BY o.business_date ORDER BY o.business_date`, from, to),
    voids: one(db, `SELECT COUNT(*) orders, COALESCE(SUM(total_cents),0) value_cents FROM orders o
      WHERE o.status = 'void' AND o.business_date BETWEEN ? AND ?`, from, to),
    voided_lines: one(db, `SELECT COALESCE(SUM(l.qty),0) qty, COALESCE(SUM(l.unit_price_cents*l.qty),0) value_cents
      FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.voided = 1 AND o.status != 'void' AND o.business_date BETWEEN ? AND ?`, from, to),
  };
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header: string[], rows: unknown[][]) =>
  [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const d2 = (cents: number) => (cents / 100).toFixed(2);
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * One row per item sold. Deliberately carries no tab names or staff names:
 * a tab name is a customer's name, and this file is meant to leave the till.
 */
export function salesLinesCsv(db: Db, from: string, to: string): string {
  const rows = all(db, `SELECT o.business_date, o.id order_no, o.closed_at, o.staff_id, l.id line_id, l.product_id, l.name, l.category,
      l.qty, l.list_price_cents, l.unit_price_cents, l.happy_hour, l.cost_cents, o.discount_cents, o.total_cents,
      (SELECT group_concat(method, '+') FROM (SELECT DISTINCT method FROM payments WHERE order_id = o.id ORDER BY method)) methods,
      (SELECT MAX(khr_rate) FROM payments WHERE order_id = o.id) khr_rate
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE l.voided = 0 AND o.status = 'paid' AND o.business_date BETWEEN ? AND ? ORDER BY o.id, l.id`, from, to);
  return toCsv(
    ['business_date', 'order_no', 'paid_at_utc', 'staff_id', 'line_id', 'product_id', 'product', 'category', 'qty', 'list_price_usd',
      'unit_price_usd', 'line_total_usd', 'happy_hour', 'unit_cost_usd', 'order_discount_usd', 'order_total_usd', 'payment_methods', 'khr_rate'],
    rows.map((r) => [r.business_date, r.order_no, iso(r.closed_at), r.staff_id, r.line_id, r.product_id, r.name, r.category, r.qty,
      d2(r.list_price_cents), d2(r.unit_price_cents), d2(r.unit_price_cents * r.qty), r.happy_hour, d2(r.cost_cents),
      d2(r.discount_cents), d2(r.total_cents), r.methods, r.khr_rate]),
  );
}

/**
 * Write one closed trading day as an OIS drop: the item-level CSV, a daily
 * aggregate JSON, and a SHA-256 sidecar for each (the OIS receipt stage hashes
 * raw bytes at arrival; shipping the hash lets the receiver prove nothing changed
 * in transit). Aggregates only, no personal data.
 */
export function writeOisExport(db: Db, dir: string, date: string, sourceId: string, tzOffsetMin: number) {
  const s = salesSummary(db, date, date, tzOffsetMin);
  const daily = {
    schema: 'ods.pos.sales_daily/v1',
    source_id: sourceId,
    business_date: date,
    period: 'day',
    currency: 'USD',
    metrics: {
      pos_gross_sales: Number(d2(s.gross_cents)),
      pos_net_sales: Number(d2(s.net_cents)),
      pos_discounts: Number(d2(s.gross_cents - s.net_cents)),
      pos_cogs: Number(d2(s.cogs_cents)),
      orders_walkin: s.orders,
      items_sold: s.items,
    },
    payment_mix: Object.fromEntries(s.by_method.map((m: any) => [m.method, Number(d2(m.amount_cents))])),
    category_mix: Object.fromEntries(s.by_category.map((c: any) => [c.category, Number(d2(c.sales_cents))])),
    sales_by_hour: Object.fromEntries(s.by_hour.map((h: any) => [String(h.hour).padStart(2, '0'), Number(d2(h.net_cents))])),
    voids: { orders: s.voids.orders, lines: s.voided_lines.qty },
  };
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    { name: `${sourceId}_sales_lines_${date}.csv`, body: salesLinesCsv(db, date, date) },
    { name: `${sourceId}_sales_daily_${date}.json`, body: JSON.stringify(daily, null, 2) + '\n' },
  ];
  return files.map((f) => {
    const sha256 = crypto.createHash('sha256').update(f.body).digest('hex');
    fs.writeFileSync(path.join(dir, f.name), f.body);
    fs.writeFileSync(path.join(dir, `${f.name}.sha256`), `${sha256}  ${f.name}\n`);
    return { name: f.name, sha256, bytes: Buffer.byteLength(f.body) };
  });
}
