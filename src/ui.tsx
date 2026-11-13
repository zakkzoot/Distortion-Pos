import { useEffect, useState, type ReactNode } from 'react';

export const btn = 'rounded-xl px-4 min-h-12 font-semibold active:scale-[0.98] transition disabled:opacity-40 disabled:pointer-events-none';
export const primary = `${btn} bg-amber-500 text-black`;
export const ghost = `${btn} bg-zinc-800 text-zinc-100`;
export const danger = `${btn} bg-red-600 text-white`;
export const input = 'w-full rounded-lg bg-zinc-900 border border-zinc-700 px-3 h-12 text-base outline-none focus:border-amber-500';
export const card = 'rounded-2xl bg-zinc-900 border border-zinc-800';
export const th = 'text-left text-xs uppercase tracking-wide text-zinc-500 font-medium px-3 py-2';
export const td = 'px-3 py-2 border-t border-zinc-800';

export function Modal({ title, onClose, children, wide }: { title: string; onClose?: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`${card} ${wide ? 'w-[860px]' : 'w-[480px]'} max-w-full max-h-full overflow-auto p-5`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold">{title}</h2>
          {onClose && <button className={ghost} onClick={onClose}>✕</button>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block mb-3"><span className="block text-sm text-zinc-400 mb-1">{label}</span>{children}</label>;
}

export function NumPad({ onKey, dot }: { onKey: (k: string) => void; dot?: boolean }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', dot ? '.' : 'C', '0', '⌫'];
  return (
    <div className="grid grid-cols-3 gap-2">
      {keys.map((k) => <button key={k} className={`${ghost} h-16 text-2xl`} onClick={() => onKey(k)}>{k}</button>)}
    </div>
  );
}
export const padEdit = (v: string, k: string) => (k === '⌫' ? v.slice(0, -1) : k === 'C' ? '' : k === '.' && v.includes('.') ? v : v + k);

// One shared prompt, driven by a promise, for manager PINs and reasons.
type Ask = { title: string; kind: 'pin' | 'text'; options?: string[]; resolve: (v: string | null) => void };
let show: (a: Ask | null) => void = () => {};
export const ask = (title: string, kind: 'pin' | 'text', options?: string[]) =>
  new Promise<string | null>((resolve) => show({ title, kind, options, resolve }));

export function AskHost() {
  const [a, setA] = useState<Ask | null>(null);
  const [v, setV] = useState('');
  useEffect(() => { show = (x) => { setV(''); setA(x); }; return () => { show = () => {}; }; }, []);
  if (!a) return null;
  const done = (val: string | null) => { a.resolve(val); setA(null); };
  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className={`${card} w-[400px] p-5`}>
        <h2 className="text-xl font-bold mb-4">{a.title}</h2>
        {a.kind === 'pin' ? (
          <>
            <div className="h-12 mb-3 text-center text-3xl tracking-[0.5em]">{'●'.repeat(v.length)}</div>
            <NumPad onKey={(k) => setV(padEdit(v, k).slice(0, 8))} />
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 mb-3">
              {a.options?.map((o) => <button key={o} className={ghost} onClick={() => done(o)}>{o}</button>)}
            </div>
            <input autoFocus className={input} value={v} onChange={(e) => setV(e.target.value)} placeholder="Other…" />
          </>
        )}
        <div className="flex gap-2 mt-4">
          <button className={`${ghost} flex-1`} onClick={() => done(null)}>Cancel</button>
          <button className={`${primary} flex-1`} disabled={a.kind === 'pin' ? v.length < 4 : !v.trim()} onClick={() => done(v.trim())}>OK</button>
        </div>
      </div>
    </div>
  );
}

/** Run an action; if the server says a manager must approve, ask for a manager PIN and retry once. */
export async function approved<T>(fn: (managerPin?: string) => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e: any) {
    if (e.status !== 403) throw e;
    const pin = await ask('Manager PIN', 'pin');
    return pin ? fn(pin) : null;
  }
}

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): [T | null, () => void, string] {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [n, setN] = useState(0);
  useEffect(() => { let on = true; fn().then((d) => on && (setData(d), setErr(''))).catch((e) => on && setErr(e.message)); return () => { on = false; }; }, [n, ...deps]);
  return [data, () => setN((x) => x + 1), err];
}

export const toast = (msg: string) => window.dispatchEvent(new CustomEvent('pos-toast', { detail: msg }));
export const guard = (fn: () => Promise<unknown>) => () => { fn().catch((e) => toast(e.message)); };
