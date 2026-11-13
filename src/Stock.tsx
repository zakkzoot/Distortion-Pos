import { useState } from 'react';
import type { Ctx } from './App';
import { api, toCents, usd } from './api';
import { Field, Modal, ask, card, ghost, guard, input, primary, td, th, toast, useLoad } from './ui';

const q = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''));
const WASTE = ['Spilled', 'Broken bottle', 'Expired / flat', 'Staff drink', 'Tasting'];

export default function Stock({ ctx }: { ctx: Ctx }) {
  const { isManager, refresh, t } = ctx;
  const [data, reload] = useLoad<any>(() => api('GET', '/api/stock'));
  const [mode, setMode] = useState<'list' | 'count' | 'in'>('list');
  const [vals, setVals] = useState<Record<number, { a?: string; b?: string }>>({});
  const [edit, setEdit] = useState<any>(null);
  const [result, setResult] = useState<any[] | null>(null);
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  if (!data) return null;
  const after = async () => { setVals({}); setMode('list'); reload(); await refresh(); };
  const setVal = (id: number, k: 'a' | 'b') => (e: any) => setVals({ ...vals, [id]: { ...vals[id], [k]: e.target.value } });

  const waste = (item: any) => guard(async () => {
    const qty = await ask(`How much ${item.name} was wasted? (${item.unit})`, 'text', item.unit === 'ml' ? ['30', '50', '330', '700'] : ['1', '2', '6']);
    if (!qty || !(Number(qty) > 0)) return;
    const reason = await ask('Reason', 'text', WASTE);
    if (!reason) return;
    await api('POST', '/api/stock/waste', { stock_item_id: item.id, qty: Number(qty), reason });
    await after();
  })();
  const submitCount = guard(async () => {
    const lines = Object.entries(vals).filter(([, v]) => v.a !== undefined && v.a !== '').map(([id, v]) => ({ stock_item_id: Number(id), counted: Number(v.a) }));
    if (!lines.length) return toast('Enter at least one count');
    setResult(await api('POST', '/api/stock/count', { lines }));
    await after();
  });
  const submitIn = guard(async () => {
    const lines = Object.entries(vals).filter(([, v]) => Number(v.a) > 0).map(([id, v]) => {
      const item = data.items.find((i: any) => i.id === Number(id));
      // Cost is typed as the price paid for this delivery line; unit cost is derived.
      return { stock_item_id: Number(id), qty: Number(v.a), unit_cost_cents: v.b ? toCents(v.b) / Number(v.a) : item.cost_cents };
    });
    if (!lines.length) return toast('Enter at least one quantity');
    await api('POST', '/api/stock/in', { lines, supplier_id: supplier ? Number(supplier) : null, note });
    setNote(''); await after();
  });
  const saveItem = guard(async () => {
    const body = { ...edit, min_qty: Number(edit.min_qty) || 0, cost_cents: Number(edit.cost_cents) || 0, supplier_id: edit.supplier_id ? Number(edit.supplier_id) : null };
    await (edit.id ? api('PUT', `/api/stock/${edit.id}`, body) : api('POST', '/api/stock', body));
    setEdit(null); await after();
  });
  const addSupplier = guard(async () => {
    const name = await ask('Supplier name', 'text');
    if (!name) return;
    const contact = (await ask('Phone / Telegram (optional)', 'text', ['-'])) ?? '';
    await api('POST', '/api/suppliers', { name, contact: contact === '-' ? '' : contact });
    reload();
  });

  return (
    <div className="h-full flex flex-col p-5 gap-3">
      <div className="flex gap-2 items-center shrink-0">
        <h1 className="text-2xl font-bold flex-1">{t('Stock')}</h1>
        {isManager && mode === 'list' && (
          <>
            <button className={ghost} onClick={() => setMode('in')}>{t('Stock in')}</button>
            <button className={ghost} onClick={() => setMode('count')}>Stocktake</button>
            <button className={ghost} onClick={() => setEdit({ name: '', name_km: '', unit: 'bottle', min_qty: 0, cost_cents: 0, supplier_id: '' })}>+ Item</button>
            <button className={ghost} onClick={addSupplier}>+ Supplier</button>
          </>
        )}
        {mode !== 'list' && (
          <>
            {mode === 'in' && (
              <>
                <select className={`${input} w-52!`} value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">Supplier…</option>{data.suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
                <input className={`${input} w-52!`} placeholder="Invoice no. / note" value={note} onChange={(e) => setNote(e.target.value)} />
              </>
            )}
            <button className={ghost} onClick={() => { setVals({}); setMode('list'); }}>Cancel</button>
            <button className={primary} onClick={mode === 'count' ? submitCount : submitIn}>{mode === 'count' ? 'Save count' : 'Receive stock'}</button>
          </>
        )}
      </div>
      <div className={`${card} flex-1 overflow-y-auto`}>
        <table className="w-full">
          <thead className="sticky top-0 bg-zinc-900"><tr>
            <th className={th}>Item</th><th className={th}>On hand</th><th className={th}>Reorder at</th><th className={th}>Cost / unit</th><th className={th}>Supplier</th>
            <th className={th}>{mode === 'count' ? 'Counted' : mode === 'in' ? 'Qty received · total paid $' : ''}</th>
          </tr></thead>
          <tbody>
            {data.items.map((i: any) => (
              <tr key={i.id}>
                <td className={td}><span className="font-semibold">{i.name}</span>{i.name_km && <span className="text-zinc-500 ml-2">{i.name_km}</span>}</td>
                <td className={`${td} ${i.qty <= i.min_qty ? 'text-red-400 font-bold' : ''}`}>{q(i.qty)} {i.unit}{i.qty <= i.min_qty && ` · ${t('Low stock')}`}</td>
                <td className={td}>{q(i.min_qty)}</td>
                <td className={td}>{i.cost_cents < 10 ? `${i.cost_cents.toFixed(2)}¢` : usd(Math.round(i.cost_cents))}</td>
                <td className={`${td} text-zinc-400`}>{i.supplier_name ?? ''}</td>
                <td className={`${td} text-right`}>
                  {mode === 'list' && <span className="flex gap-2 justify-end"><button className={ghost} onClick={() => waste(i)}>{t('Waste')}</button>{isManager && <button className={ghost} onClick={() => setEdit({ ...i, supplier_id: i.supplier_id ?? '' })}>Edit</button>}</span>}
                  {mode === 'count' && <input className={`${input} w-32!`} inputMode="decimal" value={vals[i.id]?.a ?? ''} onChange={setVal(i.id, 'a')} />}
                  {mode === 'in' && <span className="flex gap-2 justify-end"><input className={`${input} w-28!`} inputMode="decimal" placeholder={i.unit} value={vals[i.id]?.a ?? ''} onChange={setVal(i.id, 'a')} /><input className={`${input} w-28!`} inputMode="decimal" placeholder="$ paid" value={vals[i.id]?.b ?? ''} onChange={setVal(i.id, 'b')} /></span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit stock item' : 'New stock item'} onClose={() => setEdit(null)}>
          <Field label="Name"><input className={input} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Khmer name"><input className={input} value={edit.name_km} onChange={(e) => setEdit({ ...edit, name_km: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Unit (ml, can, bottle…)"><input className={input} value={edit.unit} onChange={(e) => setEdit({ ...edit, unit: e.target.value })} /></Field>
            <Field label="Reorder at"><input className={input} inputMode="decimal" value={edit.min_qty} onChange={(e) => setEdit({ ...edit, min_qty: e.target.value })} /></Field>
            <Field label="Cost per unit (cents)"><input className={input} inputMode="decimal" value={edit.cost_cents} onChange={(e) => setEdit({ ...edit, cost_cents: e.target.value })} /></Field>
          </div>
          <Field label="Supplier"><select className={input} value={edit.supplier_id} onChange={(e) => setEdit({ ...edit, supplier_id: e.target.value })}><option value="">None</option>{data.suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <div className="flex gap-2">
            {edit.id && <button className={ghost} onClick={() => { edit.active = false; saveItem(); }}>Remove</button>}
            <button className={`${primary} flex-1`} onClick={saveItem}>{t('Save')}</button>
          </div>
        </Modal>
      )}
      {result && (
        <Modal title="Stocktake result" onClose={() => setResult(null)}>
          <table className="w-full text-sm"><thead><tr><th className={th}>Item</th><th className={th}>Expected</th><th className={th}>Counted</th><th className={th}>Variance</th><th className={th}>Value</th></tr></thead>
            <tbody>{result.map((r) => <tr key={r.stock_item_id}><td className={td}>{r.name}</td><td className={td}>{q(r.expected)}</td><td className={td}>{q(r.counted)}</td><td className={`${td} ${r.variance < 0 ? 'text-red-400' : ''}`}>{q(r.variance)}</td><td className={td}>{usd(r.variance_cost_cents)}</td></tr>)}</tbody></table>
        </Modal>
      )}
    </div>
  );
}
