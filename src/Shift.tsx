import { useState } from 'react';
import type { Ctx } from './App';
import { api, riel, toCents, usd, when } from './api';
import { Field, card, ghost, guard, input, primary, td, th, useLoad } from './ui';

const signed = (n: number, f: (x: number) => string) => (n > 0 ? `+${f(n)}` : n < 0 ? `-${f(-n)}` : f(0));

export function zText(r: any, venue: string): string {
  const row = (l: string, v: string) => l.padEnd(24) + v.padStart(16);
  const s = r.shift;
  return [
    venue.toUpperCase(), `Z REPORT  shift #${s.id}  ${s.business_date}`, `Opened ${when(s.opened_at)} by ${s.opened_by_name}`,
    s.closed_at ? `Closed ${when(s.closed_at)} by ${s.closed_by_name}` : 'STILL OPEN', '-'.repeat(40),
    row('Orders', String(r.sales.orders)), row('Sales before discount', usd(r.sales.subtotal_cents)), row('Discounts', usd(-r.sales.discount_cents)), row('NET SALES', usd(r.sales.net_cents)),
    ...r.payments.map((p: any) => row(`  ${p.method}`, usd(p.amount_cents))), row('Voided orders', `${r.voids.orders} / ${usd(r.voids.value_cents)}`), '-'.repeat(40),
    row('Float USD', usd(s.float_usd_cents)), row('Float KHR', riel(s.float_khr)),
    ...r.cash_moves.map((m: any) => row(`  ${m.type} ${m.note}`.slice(0, 24), m.currency === 'USD' ? usd(m.amount) : riel(m.amount))),
    row('Expected USD', usd(r.expected_usd_cents)), row('Counted USD', usd(s.counted_usd_cents ?? 0)), row('Variance USD', signed(r.variance_usd_cents ?? 0, usd)),
    row('Expected KHR', riel(r.expected_khr)), row('Counted KHR', riel(s.counted_khr ?? 0)), row('Variance KHR', signed(r.variance_khr ?? 0, riel)), '',
  ].join('\n');
}

export default function Shift({ ctx }: { ctx: Ctx }) {
  const { boot, refresh, isManager } = ctx;
  const [cur, reload] = useLoad<any>(() => api('GET', '/api/shifts/current'), [boot.shift?.id]);
  const [history] = useLoad<any[]>(() => (isManager ? api('GET', '/api/shifts') : Promise.resolve([])), [boot.shift?.id]);
  const [z, setZ] = useState<any>(null);
  const [f, setF] = useState({ usd: '', khr: '', type: 'payout', currency: 'USD', amount: '', note: '', cUsd: '', cKhr: '' });
  const up = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const after = async () => { reload(); await refresh(); };

  const open = guard(async () => { await api('POST', '/api/shifts/open', { float_usd_cents: toCents(f.usd), float_khr: Math.round(Number(f.khr) || 0) }); setZ(null); await after(); });
  const move = guard(async () => {
    await api('POST', '/api/shifts/cash', { type: f.type, currency: f.currency, amount: f.currency === 'USD' ? toCents(f.amount) : Math.round(Number(f.amount) || 0), note: f.note });
    setF({ ...f, amount: '', note: '' }); await after();
  });
  const close = guard(async () => {
    const r = await api('POST', '/api/shifts/close', { counted_usd_cents: toCents(f.cUsd), counted_khr: Math.round(Number(f.cKhr) || 0) });
    setZ(r); setF({ ...f, cUsd: '', cKhr: '', usd: '', khr: '' }); await after();
  });
  const showZ = (id: number) => guard(async () => setZ(await api('GET', `/api/shifts/${id}`)))();

  return (
    <div className="h-full overflow-y-auto p-5 grid grid-cols-2 gap-5 content-start">
      {!boot.shift ? (
        <div className={`${card} p-5`}>
          <h2 className="text-xl font-bold mb-4">Open a shift</h2>
          <p className="text-zinc-400 mb-4">Count the float in the drawer before the first sale.</p>
          <Field label="Float USD"><input className={input} inputMode="decimal" value={f.usd} onChange={up('usd')} placeholder="0.00" /></Field>
          <Field label="Float KHR"><input className={input} inputMode="numeric" value={f.khr} onChange={up('khr')} placeholder="0" /></Field>
          <button className={`${primary} w-full h-14 text-lg`} onClick={open}>Open shift</button>
        </div>
      ) : cur?.shift && (
        <>
          <div className={`${card} p-5`}>
            <h2 className="text-xl font-bold mb-1">Shift #{cur.shift.id} · {cur.shift.business_date}</h2>
            <p className="text-zinc-400 mb-4">Opened {when(cur.shift.opened_at)} by {cur.shift.opened_by_name}. Float {usd(cur.shift.float_usd_cents)} + {riel(cur.shift.float_khr)}.</p>
            {cur.sales && (
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="rounded-xl bg-zinc-950 p-3"><div className="text-zinc-500 text-sm">Net sales</div><div className="text-2xl font-bold">{usd(cur.sales.net_cents)}</div></div>
                <div className="rounded-xl bg-zinc-950 p-3"><div className="text-zinc-500 text-sm">Orders</div><div className="text-2xl font-bold">{cur.sales.orders}</div></div>
                <div className="rounded-xl bg-zinc-950 p-3"><div className="text-zinc-500 text-sm">Drawer should hold</div><div className="text-xl font-bold">{usd(cur.expected_usd_cents)}</div><div className="text-zinc-400">{riel(cur.expected_khr)}</div></div>
                <div className="rounded-xl bg-zinc-950 p-3 text-sm">{cur.payments.map((p: any) => <div key={p.method} className="flex justify-between"><span className="uppercase text-zinc-500">{p.method}</span><span>{usd(p.amount_cents)}</span></div>)}</div>
              </div>
            )}
            <h3 className="font-semibold mb-2">Cash in / out of the drawer</h3>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <select className={input} value={f.type} onChange={up('type')}><option value="payout">Pay out</option><option value="drop">Drop to safe</option><option value="payin">Pay in</option></select>
              <select className={input} value={f.currency} onChange={up('currency')}><option>USD</option><option>KHR</option></select>
              <input className={input} inputMode="decimal" placeholder="Amount" value={f.amount} onChange={up('amount')} />
            </div>
            <div className="flex gap-2">
              <input className={input} placeholder="What for? (ice, tuk-tuk, supplier…)" value={f.note} onChange={up('note')} />
              <button className={ghost} onClick={move}>Record</button>
            </div>
            {cur.cash_moves.length > 0 && (
              <table className="w-full mt-3 text-sm"><tbody>
                {cur.cash_moves.map((m: any) => <tr key={m.id}><td className={td}>{m.type}</td><td className={td}>{m.note}</td><td className={td}>{m.staff_name}</td><td className={`${td} text-right`}>{m.currency === 'USD' ? usd(m.amount) : riel(m.amount)}</td></tr>)}
              </tbody></table>
            )}
          </div>
          <div className={`${card} p-5`}>
            <h2 className="text-xl font-bold mb-2">Close the shift</h2>
            <p className="text-zinc-400 mb-4">Count everything in the drawer, float included, and enter what you counted.</p>
            {cur.open_tabs.length > 0 && <p className="text-amber-400 mb-3">Open tabs to settle first: {cur.open_tabs.map((o: any) => o.tab_name || `#${o.id}`).join(', ')}</p>}
            <Field label="Counted USD"><input className={input} inputMode="decimal" value={f.cUsd} onChange={up('cUsd')} placeholder="0.00" /></Field>
            <Field label="Counted KHR"><input className={input} inputMode="numeric" value={f.cKhr} onChange={up('cKhr')} placeholder="0" /></Field>
            <button className={`${primary} w-full h-14 text-lg`} disabled={!f.cUsd && !f.cKhr} onClick={close}>Close shift and print Z report</button>
          </div>
        </>
      )}
      {z && (
        <div className={`${card} p-5`}>
          <pre className="font-mono text-sm whitespace-pre overflow-x-auto">{zText(z, boot.settings.venue_name)}</pre>
          <button className={`${ghost} mt-3`} onClick={() => ctx.print(zText(z, boot.settings.venue_name))}>Print</button>
        </div>
      )}
      {isManager && history && history.length > 0 && (
        <div className={`${card} p-5`}>
          <h2 className="text-xl font-bold mb-2">Past shifts</h2>
          <table className="w-full text-sm">
            <thead><tr><th className={th}>Day</th><th className={th}>Variance USD</th><th className={th}>Variance KHR</th><th className={th} /></tr></thead>
            <tbody>
              {history.filter((s) => s.closed_at).map((s) => (
                <tr key={s.id}><td className={td}>{s.business_date}</td><td className={td}>{signed(s.counted_usd_cents - s.expected_usd_cents, usd)}</td><td className={td}>{signed(s.counted_khr - s.expected_khr, riel)}</td>
                  <td className={`${td} text-right`}><button className={ghost} onClick={() => showZ(s.id)}>Z report</button></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
