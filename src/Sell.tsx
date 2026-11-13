import { useMemo, useState } from 'react';
import type { Ctx } from './App';
import { api, khrDue, riel, toCents, usd } from './api';
import { Modal, NumPad, approved, ask, danger, ghost, guard, input, padEdit, primary, toast } from './ui';

interface CartLine { product_id: number; qty: number }
const VOID_REASONS = ['Rung by mistake', 'Customer changed mind', 'Spilled / remade', 'Staff drink'];

export default function Sell({ ctx, goShift }: { ctx: Ctx; goShift: () => void }) {
  const { boot, refresh, t, lang } = ctx;
  const [cat, setCat] = useState<number>(boot.categories[0]?.id ?? 0);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [tab, setTab] = useState<any>(null); // an open tab loaded from the server
  const [paying, setPaying] = useState(false);
  const [done, setDone] = useState<any>(null);

  const rate = Number(boot.settings.khr_rate);
  const hhBp = Number(boot.settings.hh_discount_bp);
  const products = useMemo(() => new Map<number, any>(boot.products.map((p: any) => [p.id, p])), [boot.products]);
  const price = (p: any) => (boot.happy_hour && p.happy_hour ? Math.round((p.price_cents * (10000 - hhBp)) / 10000) : p.price_cents);
  const label = (p: any) => (lang === 'km' && p.name_km ? p.name_km : p.name);

  const cartTotal = cart.reduce((a, l) => a + price(products.get(l.product_id)) * l.qty, 0);
  const tabLines = (tab?.lines ?? []).filter((l: any) => !l.voided);
  // New items on a discounted tab are estimated here; the server's figure is final.
  const total = (tab?.order.total_cents ?? 0) + Math.round((cartTotal * (10000 - (tab?.order.discount_bp ?? 0))) / 10000);

  const add = (id: number) => setCart((c) => (c.some((l) => l.product_id === id) ? c.map((l) => (l.product_id === id ? { ...l, qty: l.qty + 1 } : l)) : [...c, { product_id: id, qty: 1 }]));
  const bump = (id: number, d: number) => setCart((c) => c.flatMap((l) => (l.product_id !== id ? [l] : l.qty + d > 0 ? [{ ...l, qty: l.qty + d }] : [])));
  const clear = () => { setCart([]); setTab(null); };

  const openTab = (id: number) => guard(async () => { setCart([]); setTab(await api('GET', `/api/orders/${id}`)); })();

  const saveTab = guard(async () => {
    if (tab) {
      await api('POST', `/api/orders/${tab.order.id}/lines`, { lines: cart });
    } else {
      const name = await ask(t('Customer or table name'), 'text', ['Bar 1', 'Bar 2', 'Table 1', 'Table 2', 'Table 3', 'Table 4']);
      if (!name) return;
      await api('POST', '/api/orders', { tab_name: name, lines: cart });
    }
    clear();
    await refresh();
  });

  const voidLine = (line: any) => guard(async () => {
    const reason = await ask(`Void ${line.qty} × ${line.name}`, 'text', VOID_REASONS);
    if (!reason) return;
    const restock = reason !== 'Spilled / remade' && reason !== 'Staff drink';
    const v = await approved((manager_pin) => api('POST', `/api/orders/${tab.order.id}/lines/${line.id}/void`, { reason, restock, manager_pin }));
    if (v) { setTab(v); await refresh(); }
  })();

  const discount = guard(async () => {
    const pct = await ask('Discount %', 'text', ['0', '10', '20', '50', '100']);
    if (pct == null) return;
    const bp = Math.round(Number(pct) * 100);
    if (!Number.isFinite(bp) || bp < 0 || bp > 10000) return toast('Discount must be 0 to 100');
    const reason = bp ? await ask('Reason for discount', 'text', ['Regular', 'Staff', 'Promo', 'Complaint', 'On the house']) : '';
    if (bp && !reason) return;
    const v = await approved((manager_pin) => api('POST', `/api/orders/${tab.order.id}/discount`, { bp, reason, manager_pin }));
    if (v) { setTab(v); await refresh(); }
  });

  const voidTab = guard(async () => {
    const reason = await ask(`Void whole tab "${tab.order.tab_name}"`, 'text', ['Walked out', 'Opened by mistake', 'On the house']);
    if (!reason) return;
    const v = await approved((manager_pin) => api('POST', `/api/orders/${tab.order.id}/void`, { reason, restock: reason === 'Opened by mistake', manager_pin }));
    if (v) { clear(); await refresh(); }
  });

  const pay = async (payments: any[]) => {
    let view: any;
    if (tab) {
      if (cart.length) await api('POST', `/api/orders/${tab.order.id}/lines`, { lines: cart });
      view = await api('POST', `/api/orders/${tab.order.id}/pay`, { payments });
    } else {
      view = await api('POST', '/api/orders', { lines: cart, payments });
    }
    setPaying(false);
    clear();
    setDone(view);
    refresh().catch(() => {});
    if (boot.settings.print_mode !== 'off') printReceipt(view.order.id, view.payments.some((p: any) => p.method === 'cash'));
  };
  const printReceipt = (id: number, open_drawer = false) => guard(async () => {
    const r = await api('POST', `/api/orders/${id}/print`, { open_drawer });
    if (r.printer_error) toast(`Printer: ${r.printer_error}`);
    if (!r.printed && boot.settings.print_mode !== 'network') ctx.print(r.text);
  })();

  if (!boot.shift) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <p className="text-xl text-zinc-400">No shift is open.</p>
        <button className={`${primary} text-lg px-8`} onClick={goShift}>Open a shift</button>
      </div>
    );
  }

  return (
    <div className="h-full flex">
      <section className="flex-1 min-w-0 flex flex-col p-3 gap-3">
        <div className="flex gap-2 overflow-x-auto shrink-0">
          {boot.categories.map((c: any) => (
            <button key={c.id} onClick={() => setCat(c.id)} className={`rounded-xl h-14 px-6 text-lg font-semibold shrink-0 ${cat === c.id ? 'bg-zinc-100 text-black' : 'bg-zinc-800'}`}>
              {lang === 'km' && c.name_km ? c.name_km : c.name}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] auto-rows-[96px] gap-2 content-start">
          {boot.products.filter((p: any) => p.category_id === cat).map((p: any) => (
            <button key={p.id} onClick={() => add(p.id)} className="rounded-xl bg-zinc-800 active:bg-zinc-700 p-3 text-left flex flex-col justify-between">
              <span className="font-semibold leading-tight line-clamp-2">{label(p)}</span>
              <span className="text-amber-400 font-bold">
                {usd(price(p))}
                {price(p) !== p.price_cents && <span className="ml-2 text-xs text-zinc-500 line-through">{usd(p.price_cents)}</span>}
              </span>
            </button>
          ))}
        </div>
        {boot.open_tabs.length > 0 && (
          <div className="shrink-0">
            <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">{t('Open tabs')}</div>
            <div className="flex gap-2 overflow-x-auto">
              {boot.open_tabs.map((o: any) => (
                <button key={o.id} onClick={() => openTab(o.id)} className={`rounded-xl h-12 px-4 shrink-0 font-semibold ${tab?.order.id === o.id ? 'bg-amber-500 text-black' : 'bg-zinc-800'}`}>
                  {o.tab_name} · {usd(o.total_cents)}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      <aside className="w-[380px] shrink-0 bg-zinc-950 border-l border-zinc-800 flex flex-col">
        <div className="p-3 border-b border-zinc-800 flex items-center justify-between h-16">
          <span className="text-lg font-bold truncate">{tab ? `${t('Tab')}: ${tab.order.tab_name}` : 'New sale'}</span>
          {(tab || cart.length > 0) && <button className={ghost} onClick={clear}>{tab ? 'Close' : 'Clear'}</button>}
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {tabLines.map((l: any) => (
            <div key={`t${l.id}`} className="flex items-center gap-2 text-zinc-300">
              <span className="w-8 text-center font-bold">{l.qty}</span>
              <span className="flex-1 truncate">{l.name}{l.happy_hour ? ' (HH)' : ''}</span>
              <span>{usd(l.unit_price_cents * l.qty)}</span>
              <button className="w-10 h-10 rounded-lg bg-zinc-800 text-red-400" onClick={() => voidLine(l)}>✕</button>
            </div>
          ))}
          {tabLines.length > 0 && cart.length > 0 && <div className="text-xs uppercase tracking-wide text-amber-400 pt-2">Not yet on the tab</div>}
          {cart.map((l) => {
            const p = products.get(l.product_id);
            return (
              <div key={l.product_id} className="flex items-center gap-2">
                <button className="w-10 h-10 rounded-lg bg-zinc-800 text-xl" onClick={() => bump(l.product_id, -1)}>−</button>
                <span className="w-6 text-center font-bold">{l.qty}</span>
                <button className="w-10 h-10 rounded-lg bg-zinc-800 text-xl" onClick={() => bump(l.product_id, 1)}>+</button>
                <span className="flex-1 truncate">{label(p)}</span>
                <span>{usd(price(p) * l.qty)}</span>
              </div>
            );
          })}
          {!tabLines.length && !cart.length && <p className="text-zinc-600 text-center pt-10">Tap a drink to start</p>}
        </div>
        <div className="p-3 border-t border-zinc-800 space-y-2">
          {tab?.order.discount_bp > 0 && <div className="flex justify-between text-sm text-zinc-400"><span>Discount {tab.order.discount_bp / 100}% ({tab.order.discount_reason})</span><span>{usd(-tab.order.discount_cents)}</span></div>}
          <div className="flex justify-between items-baseline">
            <span className="text-zinc-400">{t('Total')}</span>
            <span className="text-3xl font-bold">{usd(total)}</span>
          </div>
          <div className="text-right text-zinc-500">{riel(khrDue(total, rate))}</div>
          {tab && (
            <div className="grid grid-cols-3 gap-2">
              <button className={ghost} onClick={discount}>Discount</button>
              <button className={ghost} onClick={() => printReceipt(tab.order.id)}>Bill</button>
              <button className={danger} onClick={voidTab}>Void</button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button className={`${ghost} h-16 text-lg`} disabled={!cart.length} onClick={saveTab}>{tab ? 'Add to tab' : t('Tab')}</button>
            <button className={`${primary} h-16 text-xl`} disabled={!cart.length && !tabLines.length} onClick={() => setPaying(true)}>{t('Pay')}</button>
          </div>
        </div>
      </aside>

      {paying && <PayModal total={total} rate={rate} t={t} onClose={() => setPaying(false)} onPay={pay} />}
      {done && <DoneModal view={done} t={t} onClose={() => setDone(null)} onPrint={() => printReceipt(done.order.id)} />}
    </div>
  );
}

function PayModal({ total, rate, t, onClose, onPay }: { total: number; rate: number; t: (s: string) => string; onClose: () => void; onPay: (p: any[]) => Promise<void> }) {
  const [field, setField] = useState<'usd' | 'khr' | 'other'>('usd');
  const [cashUsd, setCashUsd] = useState('');
  const [cashKhr, setCashKhr] = useState('');
  const [other, setOther] = useState('');
  const [method, setMethod] = useState<'khqr' | 'card'>('khqr');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const otherCents = Math.min(toCents(other), total);
  const remaining = total - otherCents;
  const usdCents = toCents(cashUsd);
  const khr = Math.round(Number(cashKhr) || 0);
  const cashValue = usdCents + Math.floor((khr * 100) / rate);
  const change = cashValue - remaining;
  const changeUsd = Math.floor(Math.max(change, 0) / 100) * 100;
  const changeKhr = Math.floor(((Math.max(change, 0) - changeUsd) * rate) / 100 / 100) * 100;
  const ok = remaining === 0 ? cashValue === 0 : change >= 0;

  const set = { usd: setCashUsd, khr: setCashKhr, other: setOther }[field];
  const val = { usd: cashUsd, khr: cashKhr, other }[field];
  const submit = async () => {
    setBusy(true); setErr('');
    const payments: any[] = [];
    if (otherCents > 0) payments.push({ method, amount_cents: otherCents, reference });
    if (remaining > 0) payments.push({ method: 'cash', tendered_usd_cents: usdCents, tendered_khr: khr });
    try { await onPay(payments); } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const box = (f: typeof field) => `rounded-xl border-2 p-3 text-left ${field === f ? 'border-amber-500 bg-zinc-800' : 'border-zinc-700 bg-zinc-900'}`;

  return (
    <Modal title={`${t('Pay')} ${usd(total)}  ·  ${riel(khrDue(total, rate))}`} onClose={busy ? undefined : onClose} wide>
      <div className="grid grid-cols-2 gap-5">
        <div className="space-y-3">
          <button className={`${box('usd')} w-full`} onClick={() => setField('usd')}>
            <div className="text-sm text-zinc-400">{t('Cash')} USD</div>
            <div className="text-2xl font-bold">${cashUsd || '0'}</div>
          </button>
          <div className="flex flex-wrap gap-2">
            <button className={ghost} onClick={() => { setCashKhr(''); setCashUsd((remaining / 100).toFixed(2)); }}>Exact</button>
            {[5, 10, 20, 50, 100].map((n) => <button key={n} className={ghost} onClick={() => { setField('usd'); setCashUsd(String(n)); }}>${n}</button>)}
          </div>
          <button className={`${box('khr')} w-full`} onClick={() => setField('khr')}>
            <div className="text-sm text-zinc-400">{t('Cash')} KHR</div>
            <div className="text-2xl font-bold">{riel(khr)}</div>
          </button>
          <div className="flex flex-wrap gap-2">
            <button className={ghost} onClick={() => { setCashUsd(''); setCashKhr(String(khrDue(remaining, rate))); }}>Exact ៛</button>
            {[10000, 20000, 50000, 100000].map((n) => <button key={n} className={ghost} onClick={() => { setField('khr'); setCashKhr(String(n)); }}>{n / 1000}k</button>)}
          </div>
          <button className={`${box('other')} w-full`} onClick={() => setField('other')}>
            <div className="text-sm text-zinc-400">{method === 'khqr' ? 'KHQR (ABA / Bakong)' : t('Card')}</div>
            <div className="text-2xl font-bold">${other || '0'}</div>
          </button>
          <div className="flex gap-2">
            <button className={method === 'khqr' ? primary : ghost} onClick={() => setMethod('khqr')}>KHQR</button>
            <button className={method === 'card' ? primary : ghost} onClick={() => setMethod('card')}>{t('Card')}</button>
            <button className={ghost} onClick={() => { setCashUsd(''); setCashKhr(''); setOther((total / 100).toFixed(2)); }}>Full amount</button>
          </div>
          {otherCents > 0 && <input className={input} placeholder="Reference (last digits of the transfer)" value={reference} onChange={(e) => setReference(e.target.value)} />}
        </div>
        <div className="flex flex-col gap-3">
          <NumPad dot={field !== 'khr'} onKey={(k) => set(padEdit(val, k))} />
          <div className="rounded-xl bg-zinc-950 p-4 flex-1">
            {remaining > 0 && change < 0 && <div className="text-red-400 text-xl font-bold">Still to pay {usd(-change)} · {riel(khrDue(-change, rate))}</div>}
            {remaining > 0 && change >= 0 && (
              <>
                <div className="text-zinc-400">{t('Change')}</div>
                <div className="text-3xl font-bold text-emerald-400">{usd(changeUsd)}{changeKhr > 0 && ` + ${riel(changeKhr)}`}</div>
              </>
            )}
            {remaining === 0 && <div className="text-emerald-400 text-xl font-bold">Covered by {method === 'khqr' ? 'KHQR' : 'card'}. Check the payment has arrived before confirming.</div>}
            {err && <div className="text-red-400 mt-2">{err}</div>}
          </div>
          <button className={`${primary} h-16 text-xl`} disabled={!ok || busy} onClick={submit}>{t('Confirm paid')}</button>
        </div>
      </div>
    </Modal>
  );
}

function DoneModal({ view, t, onClose, onPrint }: { view: any; t: (s: string) => string; onClose: () => void; onPrint: () => void }) {
  const cash = view.payments.find((p: any) => p.method === 'cash');
  return (
    <Modal title={`Order #${view.order.id} paid`}>
      <div className="text-center py-4">
        <div className="text-zinc-400 text-lg">{t('Change')}</div>
        <div className="text-5xl font-bold text-emerald-400 my-3">
          {usd(cash?.change_usd_cents ?? 0)}
          {cash?.change_khr > 0 && <div className="text-3xl mt-2">+ {riel(cash.change_khr)}</div>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button className={`${ghost} h-16`} onClick={onPrint}>Reprint receipt</button>
        <button className={`${primary} h-16 text-xl`} onClick={onClose}>{t('Done')}</button>
      </div>
    </Modal>
  );
}
