import { useState } from 'react';
import type { Ctx } from './App';
import { api, download, pctOf, usd } from './api';
import { card, ghost, guard, input, primary, td, th, toast, useLoad } from './ui';

const today = (s: Record<string, string>) => new Date(Date.now() + Number(s.tz_offset_min) * 60000 - Number(s.day_cutoff_hour) * 3600000).toISOString().slice(0, 10);

function Table({ title, head, rows }: { title: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <div className={`${card} p-4`}>
      <h3 className="font-bold mb-2">{title}</h3>
      <table className="w-full text-sm">
        <thead><tr>{head.map((h, i) => <th key={h} className={`${th} ${i ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={`${td} ${j ? 'text-right' : ''}`}>{c}</td>)}</tr>)}</tbody>
      </table>
      {!rows.length && <p className="text-zinc-600 text-sm py-2">No sales in this period.</p>}
    </div>
  );
}

export default function Reports({ ctx }: { ctx: Ctx }) {
  const [from, setFrom] = useState(today(ctx.boot.settings));
  const [to, setTo] = useState(today(ctx.boot.settings));
  const [s] = useLoad<any>(() => api('GET', `/api/reports/summary?from=${from}&to=${to}`), [from, to]);
  const [files, reloadFiles] = useLoad<string[]>(() => api('GET', '/api/ois/exports'));
  const ois = guard(async () => {
    const r = await api('POST', '/api/ois/export', { date: from });
    toast(`Exported ${r.files.length} files to ${r.dir}`);
    reloadFiles();
  });
  const Tile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <div className={`${card} p-4`}><div className="text-zinc-500 text-sm">{label}</div><div className="text-2xl font-bold">{value}</div>{sub && <div className="text-zinc-500 text-sm">{sub}</div>}</div>
  );
  return (
    <div className="h-full overflow-y-auto p-5 space-y-4">
      <div className="flex gap-2 items-center flex-wrap">
        <h1 className="text-2xl font-bold flex-1">{ctx.t('Reports')}</h1>
        <input type="date" className={`${input} w-44!`} value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} />
        <span className="text-zinc-500">to</span>
        <input type="date" className={`${input} w-44!`} value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        <button className={ghost} onClick={guard(() => download(`/api/reports/export.csv?type=lines&from=${from}&to=${to}`, `sales_lines_${from}_${to}.csv`))}>Items CSV</button>
        <button className={ghost} onClick={guard(() => download(`/api/reports/export.csv?type=daily&from=${from}&to=${to}`, `sales_daily_${from}_${to}.csv`))}>Daily CSV</button>
      </div>
      {s && (
        <>
          <div className="grid grid-cols-5 gap-3">
            <Tile label="Net sales" value={usd(s.net_cents)} sub={`${s.orders} orders · ${s.items} drinks`} />
            <Tile label="Average order" value={usd(s.orders ? Math.round(s.net_cents / s.orders) : 0)} />
            <Tile label="Cost of drinks" value={usd(s.cogs_cents)} sub={s.net_cents ? `${pctOf(Math.round((s.cogs_cents * 10000) / s.net_cents))} pour cost` : ''} />
            <Tile label="Gross margin" value={usd(s.margin_cents)} />
            <Tile label="Given away" value={usd(s.happy_hour_cents + s.discount_cents)} sub={`HH ${usd(s.happy_hour_cents)} · discounts ${usd(s.discount_cents)} · ${s.voids.orders} voids`} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Table title="By drink" head={['Drink', 'Qty', 'Sales', 'Cost']} rows={s.by_product.map((p: any) => [p.name, p.qty, usd(p.sales_cents), usd(p.cogs_cents)])} />
            <div className="space-y-4">
              <Table title="By payment" head={['Method', 'Payments', 'Amount']} rows={s.by_method.map((m: any) => [m.method.toUpperCase(), m.payments, usd(m.amount_cents)])} />
              <Table title="By category" head={['Category', 'Qty', 'Sales']} rows={s.by_category.map((c: any) => [c.category, c.qty, usd(c.sales_cents)])} />
              <Table title="By hour" head={['Hour', 'Orders', 'Sales']} rows={s.by_hour.map((h: any) => [`${String(h.hour).padStart(2, '0')}:00`, h.orders, usd(h.net_cents)])} />
              <Table title="By staff" head={['Staff', 'Orders', 'Sales']} rows={s.by_staff.map((x: any) => [x.name, x.orders, usd(x.net_cents)])} />
            </div>
          </div>
        </>
      )}
      <div className={`${card} p-4`}>
        <div className="flex items-center gap-3 mb-2">
          <h3 className="font-bold flex-1">OIS export</h3>
          <button className={primary} onClick={ois}>Export {from} for OIS</button>
        </div>
        <p className="text-zinc-400 text-sm mb-2">Writes the day's item lines and daily totals with a SHA-256 beside each. No customer or staff names are included. Upload the pair to the venue's OIS workroom under POS.</p>
        <div className="flex flex-wrap gap-2">{files?.map((f) => <button key={f} className={`${ghost} text-sm`} onClick={guard(() => download(`/api/ois/exports/${f}`, f))}>{f}</button>)}</div>
      </div>
    </div>
  );
}
