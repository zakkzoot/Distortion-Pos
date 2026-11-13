import { useCallback, useEffect, useState } from 'react';
import { api, hasToken, setToken } from './api';
import { tr, type Lang } from './i18n';
import { AskHost, NumPad, ghost, padEdit, toast } from './ui';
import Sell from './Sell';
import Shift from './Shift';
import Stock from './Stock';
import Menu from './Menu';
import Reports from './Reports';
import Admin from './Admin';

export interface Ctx { boot: any; refresh: () => Promise<void>; t: (s: string) => string; lang: Lang; isManager: boolean; print: (text: string) => void }

function Login({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const submit = async (p: string) => {
    try { setToken((await api('POST', '/api/login', { pin: p })).token); onDone(); }
    catch (e: any) { setErr(e.message); setPin(''); }
  };
  return (
    <div className="h-full flex flex-col items-center justify-center gap-5">
      <h1 className="text-3xl font-bold">Enter PIN</h1>
      <div className="h-10 text-4xl tracking-[0.5em]">{'●'.repeat(pin.length)}</div>
      <div className="w-80"><NumPad onKey={(k) => { setErr(''); setPin(padEdit(pin, k).slice(0, 8)); }} /></div>
      <button className="w-80 rounded-xl h-14 bg-amber-500 text-black text-xl font-bold disabled:opacity-40" disabled={pin.length < 4} onClick={() => submit(pin)}>Log in</button>
      <div className="h-6 text-red-400">{err}</div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(hasToken());
  const [boot, setBoot] = useState<any>(null);
  const [tab, setTab] = useState('Sell');
  const [lang, setLang] = useState<Lang>((localStorage.getItem('pos_lang') as Lang) || 'en');
  const [msg, setMsg] = useState('');
  const [printText, setPrintText] = useState('');

  const refresh = useCallback(async () => { setBoot(await api('GET', '/api/bootstrap')); }, []);
  useEffect(() => { if (authed) refresh().catch((e) => toast(e.message)); else setBoot(null); }, [authed, refresh]);
  useEffect(() => {
    const out = () => setAuthed(false);
    let timer: any;
    const onToast = (e: Event) => { setMsg((e as CustomEvent).detail); clearTimeout(timer); timer = setTimeout(() => setMsg(''), 4000); };
    window.addEventListener('pos-logout', out);
    window.addEventListener('pos-toast', onToast);
    // Keeps the happy-hour flag and other tills' tabs current.
    const poll = setInterval(() => { if (hasToken()) refresh().catch(() => {}); }, 60000);
    return () => { window.removeEventListener('pos-logout', out); window.removeEventListener('pos-toast', onToast); clearInterval(poll); };
  }, [refresh]);
  useEffect(() => { if (printText) { const id = setTimeout(() => { window.print(); setPrintText(''); }, 50); return () => clearTimeout(id); } }, [printText]);

  if (!authed) return <><Login onDone={() => { setTab('Sell'); setAuthed(true); }} /><Toast msg={msg} /></>;
  if (!boot) return <div className="h-full flex items-center justify-center text-zinc-500">Loading…</div>;

  const isManager = boot.staff.role === 'manager';
  const t = tr(lang);
  const ctx: Ctx = { boot, refresh, t, lang, isManager, print: setPrintText };
  const tabs = ['Sell', 'Shift', 'Stock', ...(isManager ? ['Menu', 'Reports', 'Admin'] : [])];
  const logout = async () => { await api('POST', '/api/logout').catch(() => {}); setToken(''); setAuthed(false); };

  return (
    <>
      <div className="h-full flex">
        <nav className="w-28 shrink-0 bg-zinc-950 border-r border-zinc-800 flex flex-col p-2 gap-2">
          {tabs.map((x) => (
            <button key={x} onClick={() => setTab(x)} className={`rounded-xl h-16 font-semibold ${tab === x ? 'bg-amber-500 text-black' : 'bg-zinc-900 text-zinc-300'}`}>
              {t(x)}
              {x === 'Stock' && boot.low_stock > 0 && <span className="ml-1 text-xs align-top text-red-400">●</span>}
            </button>
          ))}
          <div className="flex-1" />
          {boot.happy_hour && <div className="text-center text-xs font-bold text-amber-400 py-1">{t('Happy Hour')}</div>}
          <button className={`${ghost} px-1`} onClick={() => { const l = lang === 'en' ? 'km' : 'en'; setLang(l); localStorage.setItem('pos_lang', l); }}>{lang === 'en' ? 'ខ្មែរ' : 'English'}</button>
          <div className="text-center text-xs text-zinc-500 truncate">{boot.staff.name}</div>
          <button className={`${ghost} px-1`} onClick={logout}>{t('Logout')}</button>
        </nav>
        <main className="flex-1 min-w-0 overflow-hidden">
          {tab === 'Sell' && <Sell ctx={ctx} goShift={() => setTab('Shift')} />}
          {tab === 'Shift' && <Shift ctx={ctx} />}
          {tab === 'Stock' && <Stock ctx={ctx} />}
          {tab === 'Menu' && <Menu ctx={ctx} />}
          {tab === 'Reports' && <Reports ctx={ctx} />}
          {tab === 'Admin' && <Admin ctx={ctx} />}
        </main>
      </div>
      <AskHost />
      <Toast msg={msg} />
      <pre id="print-area">{printText}</pre>
    </>
  );
}

function Toast({ msg }: { msg: string }) {
  return msg ? <div className="fixed z-[60] bottom-6 left-1/2 -translate-x-1/2 bg-red-600 text-white font-semibold px-5 py-3 rounded-xl shadow-xl">{msg}</div> : null;
}
