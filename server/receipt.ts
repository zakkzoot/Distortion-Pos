import net from 'node:net';
import { khrDue, usd, vatIncluded } from './money';

export interface ReceiptData {
  settings: Record<string, string>;
  order: any;
  lines: any[];
  payments: any[];
  staffName: string;
  localTime: string;
}

const riel = (n: number) => `${n.toLocaleString('en-US')} R`;

/** Fixed-width receipt text. Latin only: thermal printers have no Khmer font built in. */
export function receiptText(d: ReceiptData): string {
  const cols = Number(d.settings.receipt_cols) || 42;
  const rate = d.payments[0]?.khr_rate ?? Number(d.settings.khr_rate);
  const centre = (s: string) => ' '.repeat(Math.max(0, Math.floor((cols - s.length) / 2))) + s;
  const row = (l: string, r: string) => l.slice(0, cols - r.length - 1).padEnd(cols - r.length) + r;
  const rule = '-'.repeat(cols);
  const out = [centre(d.settings.venue_name.toUpperCase())];
  if (d.settings.venue_address) out.push(centre(d.settings.venue_address));
  out.push(rule, row(`Order #${d.order.id}`, d.localTime), row(`Staff: ${d.staffName}`, d.order.tab_name ? `Tab: ${d.order.tab_name}` : ''), rule);
  for (const l of d.lines) {
    out.push(row(`${l.qty} x ${l.name}${l.happy_hour ? ' (HH)' : ''}`, usd(l.unit_price_cents * l.qty)));
  }
  out.push(rule);
  if (d.order.discount_cents) {
    out.push(row('Subtotal', usd(d.order.subtotal_cents)), row(`Discount ${d.order.discount_bp / 100}%`, usd(-d.order.discount_cents)));
  }
  out.push(row('TOTAL', usd(d.order.total_cents)), row('TOTAL (KHR)', riel(khrDue(d.order.total_cents, rate))));
  const vat = vatIncluded(d.order.total_cents, Number(d.settings.vat_bp));
  if (vat) out.push(row('incl. VAT', usd(vat)));
  if (d.order.status === 'open') out.push(rule, centre('*** UNPAID - TAB OPEN ***'));
  for (const p of d.payments) {
    if (p.method === 'cash') {
      if (p.tendered_usd_cents) out.push(row('Cash USD', usd(p.tendered_usd_cents)));
      if (p.tendered_khr) out.push(row('Cash KHR', riel(p.tendered_khr)));
      if (p.change_usd_cents) out.push(row('Change USD', usd(p.change_usd_cents)));
      if (p.change_khr) out.push(row('Change KHR', riel(p.change_khr)));
    } else {
      out.push(row(p.method === 'khqr' ? 'KHQR' : 'Card', usd(p.amount_cents)));
      if (p.reference) out.push(row('Ref', p.reference));
    }
  }
  out.push(rule, row('Rate', `$1 = ${riel(rate)}`));
  if (d.settings.receipt_footer) out.push('', centre(d.settings.receipt_footer));
  return out.join('\n') + '\n';
}

const ESC = 0x1b, GS = 0x1d;
/** ESC/POS job: reset, text, feed, partial cut, and optionally kick the cash drawer. */
export function escposJob(text: string, openDrawer: boolean): Buffer {
  const parts = [Buffer.from([ESC, 0x40]), Buffer.from(text.replace(/[^\x0a\x20-\x7e]/g, '?'), 'ascii'), Buffer.from([0x0a, 0x0a, 0x0a, GS, 0x56, 0x01])];
  if (openDrawer) parts.push(Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]));
  return Buffer.concat(parts);
}

/** Send raw bytes to a network receipt printer (port 9100). */
export function sendToPrinter(host: string, port: number, job: Buffer, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error('printer timed out')));
    sock.on('connect', () => sock.end(job));
    sock.on('close', (hadError) => { if (!hadError) resolve(); });
    sock.on('error', reject);
  });
}
