/**
 * Минимальный клиент к Ozon Performance API (рекламный кабинет — CPC/CPM-кампании, статистика
 * показов/кликов). Это ОТДЕЛЬНЫЙ API от основного Seller API (lib/integrations/ozon.ts): другой
 * домен, другая пара ключей (Client-Id/Client-Secret рекламного кабинета — берутся в личном
 * кабинете Ozon Seller: Продвижение → Настройки Performance API, это НЕ те же Client-Id/Api-Key,
 * что для Seller API) и другой способ авторизации — OAuth2 client_credentials с Bearer-токеном,
 * а не пара заголовков Client-Id/Api-Key на каждый запрос.
 *
 * Задокументированный, но пока не подключённый в приложении API — здесь только авторизация и
 * проверка подключения (testOzonPerformanceConnection). Получение самой статистики (показы/клики/
 * CTR) для CTR-столбца на «Расходах» — следующий шаг, отдельная задача: у Ozon это асинхронный
 * отчёт (POST /api/client/statistics/json → опрос GET /api/client/statistics/{uuid} до готовности),
 * и кампании там не привязаны к товару напрямую — понадобится решить, как сопоставлять кампанию
 * с конкретным SKU, прежде чем встраивать это в таблицу «Товары: подробно по каждому расходу».
 */

const OZON_PERF_API_BASE = 'https://api-performance.ozon.ru';

export interface OzonPerfCredentials {
  clientId: string;
  clientSecret: string;
}

interface TokenResult {
  ok: boolean;
  message: string;
  accessToken?: string;
  expiresInSeconds?: number;
}

/** Получает OAuth-токен (grant_type: client_credentials). Токен живёт ограниченное время
 *  (Ozon обычно отдаёт expires_in ~1800 секунд) — здесь без кеширования, вызывающий код сам
 *  решает, когда токен нужен заново; кеширование имеет смысл добавить, когда появится реальный
 *  постоянный опрос статистики, а не разовая проверка подключения. */
async function fetchAccessToken(creds: OzonPerfCredentials): Promise<TokenResult> {
  try {
    const res = await fetch(`${OZON_PERF_API_BASE}/api/client/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        grant_type: 'client_credentials',
      }),
      cache: 'no-store',
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json?.message || json?.error_description || json?.error || text;
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `Неверный Client-Id или Client-Secret рекламного кабинета (Ozon: ${msg ?? res.status})` };
      }
      return { ok: false, message: msg ? String(msg) : `Ozon Performance API вернул ошибку ${res.status}` };
    }
    const accessToken = json?.access_token;
    if (!accessToken) {
      return { ok: false, message: 'Ozon Performance API не вернул access_token — формат ответа изменился, нужна проверка.' };
    }
    return { ok: true, message: 'Токен получен.', accessToken, expiresInSeconds: Number(json?.expires_in) || 1800 };
  } catch (e) {
    return { ok: false, message: `Не удалось связаться с Ozon Performance API: ${(e as Error).message}` };
  }
}

/** Дешёвая проверка, что Client-Id/Client-Secret рабочие — просто получает токен и ничего
 *  больше не запрашивает (аналог testOzonConnection в lib/integrations/ozon.ts). */
export async function testOzonPerformanceConnection(creds: OzonPerfCredentials): Promise<{ ok: boolean; message: string }> {
  const result = await fetchAccessToken(creds);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, message: 'Подключение успешно — токен получен.' };
}
