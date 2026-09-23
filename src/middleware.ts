import { NextResponse, type NextRequest } from 'next/server';

/**
 * «Запоминание» фильтра (магазин + период) между разделами.
 *
 * Раньше фильтр жил только в URL (?projectId=…&from=…&to=…), а ссылки в меню ведут на голые
 * /dashboard, /products и т.д. — поэтому при переходе в другой раздел магазин сбрасывался на
 * первый в списке. Теперь:
 *  - если в URL раздела есть фильтр — запоминаем его в cookie;
 *  - если заходим в раздел без фильтра в URL, а в cookie он есть — перенаправляем на тот же
 *    раздел с сохранённым фильтром.
 * Страницы ничего не знают про cookie и по-прежнему читают фильтр только из URL, поэтому
 * проверка доступа к магазину (assertProjectAccess / список доступных магазинов) не меняется:
 * чужой projectId из cookie так же отбрасывается, как и чужой из URL.
 */

// Магазин помним долго (полгода), период — до закрытия браузера, чтобы через неделю не
// открывался устаревший период вместо текущего месяца.
const LONG_KEYS = ['projectId', 'storeId'] as const;
const SESSION_KEYS = ['from', 'to'] as const;
const ALL_KEYS = [...LONG_KEYS, ...SESSION_KEYS];
// «По какой дате считать» есть не на всех страницах — его только запоминаем, когда он есть,
// и не стираем, когда фильтр отправлен со страницы без этого выбора.
const STICKY_KEY = 'dateBasis';

const cookieName = (k: string) => `aaf_${k}`;

export function middleware(req: NextRequest) {
  // Только обычные переходы: POST — это server actions (кнопки/формы на странице), их не трогаем.
  if (req.method !== 'GET') return NextResponse.next();
  const url = req.nextUrl;
  const params = url.searchParams;
  const hasFilterInUrl = ALL_KEYS.some((k) => params.has(k));

  if (!hasFilterInUrl) {
    // clone() сохраняет хост, по которому пришёл запрос, — Next сам делает редирект относительным.
    const restored = url.clone();
    let changed = false;
    for (const k of [...ALL_KEYS, STICKY_KEY]) {
      const v = req.cookies.get(cookieName(k))?.value;
      if (v && !restored.searchParams.has(k)) {
        restored.searchParams.set(k, v);
        changed = true;
      }
    }
    if (!changed) return NextResponse.next();
    return NextResponse.redirect(restored);
  }

  const res = NextResponse.next();
  const base = { path: '/', sameSite: 'lax' as const, httpOnly: true, secure: url.protocol === 'https:' };
  for (const k of ALL_KEYS) {
    const v = params.get(k);
    const long = (LONG_KEYS as readonly string[]).includes(k);
    if (v) res.cookies.set(cookieName(k), v, long ? { ...base, maxAge: 60 * 60 * 24 * 180 } : base);
    else res.cookies.delete(cookieName(k));
  }
  const db = params.get(STICKY_KEY);
  if (db) res.cookies.set(cookieName(STICKY_KEY), db, base);
  return res;
}

// Разделы с фильтром магазина/периода. Next требует здесь литерал (без вычислений).
export const config = {
  matcher: ['/dashboard', '/products', '/expenses', '/ai-analyst', '/reports'],
};
