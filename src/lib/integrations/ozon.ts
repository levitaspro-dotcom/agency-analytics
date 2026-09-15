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
 * Разбивает период на куски по календарным месяцам — новый метод Ozon
 * (см. ниже) принимает диапазон не длиннее одного месяца за запрос.
 */
function monthChunks(dateFrom: Date, dateTo: Date): { from: Date; to: Date }[] {
  const chunks: { from: Date; to: Date }[] = [];
  let cursor = new Date(dateFrom.getTime());
  while (cursor < dateTo) {
    const nextMonthStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const chunkEnd = nextMonthStart < dateTo ? nextMonthStart : dateTo;
    chunks.push({ from: cursor, to: chunkEnd });
    cursor = nextMonthStart;
  }
  return chunks;
}

/** Ищет массив операций в ответе — формат ответа у нового метода не задокументирован публично на 100%, поэтому проверяем несколько вероятных мест. */
function extractOperationsArray(json: any): any[] | null {
  const candidates = [json?.result?.operations, json?.result?.postings, json?.result?.items, json?.postings, json?.operations, json?.items];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return null;
}

function shortJsonPreview(json: any): string {
  try {
    const topLevelKeys = json && typeof json === 'object' ? Object.keys(json) : [];
    return JSON.stringify({ topLevelKeys, sample: json }).slice(0, 500);
  } catch {
    return 'не удалось прочитать структуру ответа';
  }
}

/** Приводит «сырую» запись из ответа Ozon к нашему внутреннему формату, независимо от точных имён полей нового метода. */
function normalizeOperation(raw: any): OzonOperation | null {
  if (!raw || typeof raw !== 'object') return null;
  const operation_date = raw.operation_date ?? raw.date ?? raw.accrual_date;
  if (!operation_date) return null;
  const operation_type = raw.operation_type ?? raw.type ?? 'unknown';
  const operation_id =
    raw.operation_id ?? raw.id ?? `${raw.posting_number ?? ''}:${operation_type}:${operation_date}`;
  const operation_type_name = raw.operation_type_name ?? raw.type_name ?? operation_type;
  const accruals_for_sale = Number(raw.accruals_for_sale ?? raw.accrual_amount ?? 0) || 0;
  const amount = Number(raw.amount ?? raw.total_amount ?? raw.sum ?? 0) || 0;
  const sale_commission = raw.sale_commission !== undefined ? Number(raw.sale_commission) : undefined;
  return { operation_id, operation_type, operation_type_name, operation_date, accruals_for_sale, amount, sale_commission };
}

/**
 * Забирает финансовые операции Ozon (продажи, комиссии, логистика, возвраты и т.д.)
 * за период. Себестоимость и налоги Ozon не знает — они остаются на стороне приложения.
 *
 * Метод /v3/finance/transaction/list, которым мы пользовались раньше, Ozon отключил
 * (возвращает "obsolete method cannot be used"). Используем актуальный на его замену —
 * /v1/finance/accrual/postings. Разбор ответа сделан защитно: если формат ответа не
 * совпадёт с ожидаемым — синхронизация не притворится «успешной с нулём операций»,
 * а вернёт ok:false с диагностикой реальной структуры ответа, чтобы это было видно
 * в интерфейсе и можно было быстро донастроить сопоставление полей.
 */
export async function fetchOzonFinanceTransactions(
  creds: OzonCredentials,
  dateFrom: Date,
  dateTo: Date,
): Promise<OzonSyncResult> {
  const operations: OzonOperation[] = [];
  const pageSize = 1000;
  const maxPages = 20; // защита от бесконечной пагинации на очень крупных кабинетах
  let unrecognizedSample: string | null = null;

  for (const chunk of monthChunks(dateFrom, dateTo)) {
    let page = 1;
    while (page <= maxPages) {
      const { ok, status, json } = await ozonFetch(creds, '/v1/finance/accrual/postings', {
        filter: { date: { from: chunk.from.toISOString(), to: chunk.to.toISOString() } },
        page,
        page_size: pageSize,
      });
      if (!ok) {
        return { ok: false, message: ozonErrorMessage(status, json), operations };
      }
      const rawList = extractOperationsArray(json);
      if (rawList === null) {
        if (!unrecognizedSample) unrecognizedSample = shortJsonPreview(json);
        break;
      }
      for (const raw of rawList) {
        const normalized = normalizeOperation(raw);
        if (normalized) operations.push(normalized);
      }
      if (rawList.length < pageSize) break;
      page += 1;
    }
  }

  if (unrecognizedSample) {
    return {
      ok: false,
      message: `Ozon вернул ответ в незнакомом формате — нужна донастройка интеграции. Структура ответа: ${unrecognizedSample}`,
      operations,
    };
  }

  return { ok: true, message: `Загружено операций: ${operations.length}`, operations };
}
