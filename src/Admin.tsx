import { useState } from 'react';
import type { Ctx } from './App';
import { api, when } from './api';
import { Field, ask, card, ghost, guard, input, primary, td, th, toast, useLoad } from './ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Admin({ ctx }: { ctx: Ctx }) {
  const { boot, refresh } = ctx;
  const [staff, reloadStaff] = useLoad<any[]>(() => api('GET', '/api/staff'));
  const [audit] = useLoad<any[]>(() => api('GET', '/api/audit'));
  const [s, setS] = useState<Record<string, string>>(boot.settings);
  const up = (k: string) => (e: any) => setS({ ...s, [k]: e.target.value });
  const days = s.hh_days.split(',').filter(Boolean);

  const addStaff = guard(async () => {
    const name = await ask('Name', 'text');
    if (!name) return;
    const role = await ask('Role', 'text', ['bartender', 'manager']);
    if (role !== 'bartender' && role !== 'manager') return;
    const pin = await ask('Choose a PIN (4 to 8 digits)', 'pin');
    if (!pin) return;
    await api('POST', '/api/staff', { name, role, pin });
    reloadStaff();
  });
  const newPin = (id: number) => guard(async () => {
    const pin = await ask('New PIN (4 to 8 digits)', 'pin');
    if (!pin) return;
    await api('PUT', `/api/staff/${id}`, { pin });
    toast('PIN changed');
  })();
  const toggle = (x: any) => guard(async () => { await api('PUT', `/api/staff/${x.id}`, { active: !x.active }); reloadStaff(); })();
  const save = guard(async () => { await api('PUT', '/api/settings', s); await refresh(); toast('Settings saved'); });

  return (
    <div className="h-full overflow-y-auto p-5 grid grid-cols-2 gap-5 content-start">
      <div className={`${card} p-5`}>
        <div className="flex items-center mb-3"><h2 className="text-xl font-bold flex-1">{ctx.t('Staff')}</h2><button className={primary} onClick={addStaff}>+ Staff</button></div>
        <table className="w-full"><tbody>
          {staff?.map((x) => (
            <tr key={x.id} className={x.active ? '' : 'opacity-40'}>
              <td className={td}>{x.name}</td><td className={`${td} text-zinc-400`}>{x.role}</td>
              <td className={`${td} text-right`}><span className="flex gap-2 justify-end"><button className={ghost} onClick={() => newPin(x.id)}>New PIN</button><button className={ghost} onClick={() => toggle(x)}>{x.active ? 'Disable' : 'Enable'}</button></span></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className={`${card} p-5 row-span-2`}>
        <h2 className="text-xl font-bold mb-3">Settings</h2>
        <Field label="Venue name (top of receipt)"><input className={input} value={s.venue_name} onChange={up('venue_name')} /></Field>
        <Field label="Address"><input className={input} value={s.venue_address} onChange={up('venue_address')} /></Field>
        <Field label="Receipt footer"><input className={input} value={s.receipt_footer} onChange={up('receipt_footer')} /></Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Riel per $1"><input className={input} inputMode="numeric" value={s.khr_rate} onChange={up('khr_rate')} /></Field>
          <Field label="VAT in prices (bp, 1000 = 10%)"><input className={input} inputMode="numeric" value={s.vat_bp} onChange={up('vat_bp')} /></Field>
          <Field label="Target pour cost (bp)"><input className={input} inputMode="numeric" value={s.target_pour_cost_bp} onChange={up('target_pour_cost_bp')} /></Field>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <Field label="Happy hour"><select className={input} value={s.hh_enabled} onChange={up('hh_enabled')}><option value="1">On</option><option value="0">Off</option></select></Field>
          <Field label="From"><input type="time" className={input} value={s.hh_start} onChange={up('hh_start')} /></Field>
          <Field label="Until"><input type="time" className={input} value={s.hh_end} onChange={up('hh_end')} /></Field>
          <Field label="Discount (bp)"><input className={input} inputMode="numeric" value={s.hh_discount_bp} onChange={up('hh_discount_bp')} /></Field>
        </div>
        <div className="flex gap-2 mb-3">
          {DAYS.map((d, i) => {
            const on = days.includes(String(i));
            return <button key={d} className={`${on ? primary : ghost} flex-1 px-1`} onClick={() => setS({ ...s, hh_days: (on ? days.filter((x) => x !== String(i)) : [...days, String(i)]).sort().join(',') })}>{d}</button>;
          })}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Receipts"><select className={input} value={s.print_mode} onChange={up('print_mode')}><option value="browser">Windows printer</option><option value="network">Network ESC/POS</option><option value="off">Off</option></select></Field>
          <Field label="Printer IP"><input className={input} value={s.printer_host} onChange={up('printer_host')} placeholder="192.168.1.50" /></Field>
          <Field label="Receipt width (chars)"><input className={input} inputMode="numeric" value={s.receipt_cols} onChange={up('receipt_cols')} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Trading day ends at (hour)"><input className={input} inputMode="numeric" value={s.day_cutoff_hour} onChange={up('day_cutoff_hour')} /></Field>
          <Field label="OIS source id"><input className={input} value={s.ois_source_id} onChange={up('ois_source_id')} /></Field>
        </div>
        <button className={`${primary} w-full h-14 text-lg`} onClick={save}>{ctx.t('Save')}</button>
      </div>
      <div className={`${card} p-5`}>
        <h2 className="text-xl font-bold mb-3">Audit log</h2>
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead><tr><th className={th}>When</th><th className={th}>Who</th><th className={th}>What</th><th className={th}>Detail</th></tr></thead>
            <tbody>{audit?.map((a) => <tr key={a.id}><td className={`${td} whitespace-nowrap`}>{when(a.ts)}</td><td className={td}>{a.staff_name ?? '—'}</td><td className={td}>{a.action}</td><td className={`${td} text-zinc-500 break-all`}>{a.detail === '{}' ? '' : a.detail}</td></tr>)}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
