import { useState } from 'react';
import type { Ctx } from './App';
import { api, pctOf, toCents, usd } from './api';
import { Field, Modal, ask, card, ghost, guard, input, primary, td, th, useLoad } from './ui';

export default function Menu({ ctx }: { ctx: Ctx }) {
  const { refresh, t } = ctx;
  const [menu, reload] = useLoad<any>(() => api('GET', '/api/menu'));
  const [stock] = useLoad<any>(() => api('GET', '/api/stock'));
  const [edit, setEdit] = useState<any>(null);
  if (!menu || !stock) return null;
  const target = Number(ctx.boot.settings.target_pour_cost_bp);
  const catName = (id: number) => menu.categories.find((c: any) => c.id === id)?.name ?? '';

  const save = guard(async () => {
    const body = { ...edit, price_cents: toCents(edit.price), category_id: Number(edit.category_id), sort: Number(edit.sort) || 0,
      recipe: edit.recipe.filter((r: any) => r.stock_item_id && Number(r.qty) > 0).map((r: any) => ({ stock_item_id: Number(r.stock_item_id), qty: Number(r.qty) })) };
    await (edit.id ? api('PUT', `/api/products/${edit.id}`, body) : api('POST', '/api/products', body));
    setEdit(null); reload(); await refresh();
  });
  const addCategory = guard(async () => {
    const name = await ask('New category', 'text', ['Wine', 'Shots', 'Buckets', 'Bottles']);
    if (!name) return;
    await api('POST', '/api/categories', { name, sort: menu.categories.length + 1 });
    reload(); await refresh();
  });
  const start = (p?: any) => setEdit(p ? { ...p, price: (p.price_cents / 100).toFixed(2), happy_hour: !!p.happy_hour, active: !!p.active, recipe: p.recipe.map((r: any) => ({ ...r })) }
    : { name: '', name_km: '', category_id: menu.categories[0]?.id, price: '', happy_hour: false, active: true, sort: menu.products.length + 1, recipe: [] });
  const setRecipe = (i: number, k: string, v: string) => setEdit({ ...edit, recipe: edit.recipe.map((r: any, j: number) => (j === i ? { ...r, [k]: v } : r)) });

  return (
    <div className="h-full flex flex-col p-5 gap-3">
      <div className="flex gap-2 items-center shrink-0">
        <h1 className="text-2xl font-bold flex-1">{t('Menu')}</h1>
        <span className="text-zinc-500 text-sm">Suggested price = ingredient cost ÷ {pctOf(target)} target pour cost</span>
        <button className={ghost} onClick={addCategory}>+ Category</button>
        <button className={primary} onClick={() => start()}>+ Drink</button>
      </div>
      <div className={`${card} flex-1 overflow-y-auto`}>
        <table className="w-full">
          <thead className="sticky top-0 bg-zinc-900"><tr><th className={th}>Drink</th><th className={th}>Category</th><th className={th}>Price</th><th className={th}>Cost</th><th className={th}>Pour cost</th><th className={th}>Suggested</th><th className={th} /></tr></thead>
          <tbody>
            {menu.products.map((p: any) => (
              <tr key={p.id} className={p.active ? '' : 'opacity-40'}>
                <td className={td}><span className="font-semibold">{p.name}</span>{p.happy_hour ? <span className="ml-2 text-xs text-amber-400">HH</span> : null}{!p.recipe.length && <span className="ml-2 text-xs text-red-400">no recipe</span>}</td>
                <td className={td}>{catName(p.category_id)}</td>
                <td className={td}>{usd(p.price_cents)}</td>
                <td className={td}>{usd(p.cost_cents)}</td>
                <td className={`${td} ${p.pour_cost_bp > target ? 'text-red-400 font-bold' : 'text-emerald-400'}`}>{p.recipe.length ? pctOf(p.pour_cost_bp) : '—'}</td>
                <td className={td}>{p.suggested_price_cents ? usd(p.suggested_price_cents) : '—'}</td>
                <td className={`${td} text-right`}><button className={ghost} onClick={() => start(p)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? 'Edit drink' : 'New drink'} onClose={() => setEdit(null)} wide>
          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Name"><input className={input} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Khmer name"><input className={input} value={edit.name_km} onChange={(e) => setEdit({ ...edit, name_km: e.target.value })} /></Field>
            <Field label="Category"><select className={input} value={edit.category_id} onChange={(e) => setEdit({ ...edit, category_id: e.target.value })}>{menu.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Price USD"><input className={input} inputMode="decimal" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></Field>
          </div>
          <div className="flex gap-6 mb-4">
            <label className="flex items-center gap-2 h-12"><input type="checkbox" className="w-6 h-6" checked={edit.happy_hour} onChange={(e) => setEdit({ ...edit, happy_hour: e.target.checked })} /> Discounted in happy hour</label>
            <label className="flex items-center gap-2 h-12"><input type="checkbox" className="w-6 h-6" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> On the menu</label>
          </div>
          <h3 className="font-semibold mb-2">Recipe: what one serve takes off the shelf</h3>
          {edit.recipe.map((r: any, i: number) => (
            <div key={i} className="flex gap-2 mb-2">
              <select className={input} value={r.stock_item_id} onChange={(e) => setRecipe(i, 'stock_item_id', e.target.value)}><option value="">Stock item…</option>{stock.items.map((s: any) => <option key={s.id} value={s.id}>{s.name} ({s.unit})</option>)}</select>
              <input className={`${input} w-32!`} inputMode="decimal" placeholder="Qty" value={r.qty} onChange={(e) => setRecipe(i, 'qty', e.target.value)} />
              <button className={ghost} onClick={() => setEdit({ ...edit, recipe: edit.recipe.filter((_: any, j: number) => j !== i) })}>✕</button>
            </div>
          ))}
          <div className="flex gap-2 mt-3">
            <button className={ghost} onClick={() => setEdit({ ...edit, recipe: [...edit.recipe, { stock_item_id: '', qty: '' }] })}>+ Ingredient</button>
            <div className="flex-1" />
            <button className={`${primary} px-10`} onClick={save}>{t('Save')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
