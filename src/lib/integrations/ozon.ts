/**
 * Минимальный клиент к Ozon Seller API.
 *
 * Реализован как отдельный, легко заменяемый модуль (аналогично слою ИИ-адаптеров):
 * вся специфика Ozon — здесь, остальное приложение работает с обычными
 * FinanceTransaction-записями и не знает деталей API площадки.
 *
 * Документация: https://docs.ozon.ru/api/seller/
 */

const OZON_API_BASE = 'https://api-seller.ozon.ru';

export interface OzonCredentials {
  clientId: string;
  apiKey: string;
}

interface OzonFetchResult {
  ok: boolean;
  status: number;
  json: any;
}

async function ozonFetch(creds: OzonCredentials, path: string, body: unknown): Promise<OzonFetchResult> {
  const res = await fetch(`${OZON_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Client-Id': creds.clientId,
      'Api-Key': creds.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

function ozonErrorMessage(status: number, json: any): string {
  const msg = json?.message || json?.error?.message || json?.code;
  if (status === 401 || status === 403) {
    return `Неверный Client-Id или Api-Key (Ozon: ${msg ?? status})`;
  }
  if (status === 429) {
    return 'Ozon временно ограничил число запросов (429). Попробуйте позже.';
  }
  return msg ? String(msg) : `Ozon вернул ошибку ${status}`;
}

/** Дешёвый read-only вызов, чтобы проверить, что Client-Id/Api-Key рабочие. */
export async function testOzonConnection(creds: OzonCredentials): Promise<{ ok: boolean; message: string }> {
  try {
    const { ok, status, json } = await ozonFetch(creds, '/v3/product/list', { filter: {}, limit: 1 });
    if (ok) return { ok: true, message: 'Подключение успешно.' };
    return { ok: false, message: ozonErrorMessage(status, json) };
  } catch (e) {
    return { ok: false, message: `Не удалось связаться с Ozon: ${(e as Error).message}` };
  }
}

export interface OzonOperation {
  operation_id: number | string;
  operation_type: string;
  operation_type_name: string;
  operation_date: string;
  accruals_for_sale: number;
  amount: number;
  sale_commission?: number;
}

export interface OzonSyncResult {
  ok: boolean;
  message: string;
  operations: OzonOperation[];
}

/**
 * Забирает финансовые операции Ozon (продажи, комиссии, логистика, возвраты и т.д.)
 * за период. Себестоимость и налоги Ozon не знает — они остаются на стороне приложения.
 */
export async function fetchOzonFinanceTransactions(
  creds: OzonCredentials,
  dateFrom: Date,
  dateTo: Date,
): Promise<OzonSyncResult> {
  const operations: OzonOperation[] = [];
  let page = 1;
  const pageSize = 1000;
  const maxPages = 20; // защита от бесконечной пагинации на очень крупных кабинетах

  while (page <= maxPages) {
    const { ok, status, json } = await ozonFetch(creds, '/v3/finance/transaction/list', {
      filter: {
        date: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
        transaction_type: 'all',
      },
      page,
      page_size: pageSize,
    });
    if (!ok) {
      return { ok: false, message: ozonErrorMessage(status, json), operations };
    }
    const pageOps: OzonOperation[] = json?.result?.operations ?? [];
    operations.push(...pageOps);
    if (pageOps.length < pageSize) break;
    page += 1;
  }

  return { ok: true, message: `Загружено операций: ${operations.length}`, operations };
}
