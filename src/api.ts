let token = sessionStorage.getItem('pos_token') ?? '';
export const hasToken = () => !!token;
export const setToken = (t: string) => { token = t; t ? sessionStorage.setItem('pos_token', t) : sessionStorage.removeItem('pos_token'); };

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function raw(method: string, url: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Cannot reach the till server');
  }
  if (res.status === 401 && url !== '/api/login') { setToken(''); window.dispatchEvent(new Event('pos-logout')); }
  if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error ?? `Error ${res.status}`);
  return res;
}

export const api = async <T = any>(method: string, url: string, body?: unknown): Promise<T> => (await raw(method, url, body)).json();

export async function download(url: string, filename: string) {
  const blob = await (await raw('GET', url)).blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const usd = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
export const riel = (n: number) => `${n.toLocaleString('en-US')} ៛`;
export const khrDue = (cents: number, rate: number) => Math.ceil((cents * rate) / 100 / 100) * 100;
export const toCents = (s: string) => Math.round((parseFloat(s) || 0) * 100);
export const pctOf = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}%`;
export const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Phnom_Penh', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
