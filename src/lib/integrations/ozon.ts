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

/** Разбивает массив на батчи фиксированного размера (Ozon принимает не больше 200 posting_numbers за один запрос). */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Собирает номера отправлений (posting_number) за период через два стабильных,
 * давно не менявшихся метода Ozon — отдельно FBS и FBO (у аккаунта может быть
 * задействована любая из схем или обе сразу).
 */
async function fetchPostingNumbers(creds: OzonCredentials, dateFrom: Date, dateTo: Date): Promise<{ postingNumbers: string[]; errors: string[] }> {
  const postingNumbers = new Set<string>();
  const errors: string[] = [];

  // FBS: POST /v3/posting/fbs/list — пагинация limit/offset, лимит страницы до 50, признак конца — has_next.
  {
    let offset = 0;
    const limit = 50;
    for (let guard = 0; guard < 200; guard++) {
      const { ok, status, json } = await ozonFetch(creds, '/v3/posting/fbs/list', {
        dir: 'ASC',
        filter: { since: dateFrom.toISOString(), to: dateTo.toISOString() },
        limit,
        offset,
      });
      if (!ok) {
        errors.push(`FBS: ${ozonErrorMessage(status, json)}`);
        break;
      }
      const postings: any[] = json?.result?.postings ?? [];
      for (const p of postings) if (p?.posting_number) postingNumbers.add(String(p.posting_number));
      if (!json?.result?.has_next || postings.length === 0) break;
      offset += limit;
    }
  }

  // FBO: POST /v2/posting/fbo/list — пагинация limit/offset, лимит страницы до 1000, признак конца — неполная страница.
  {
    let offset = 0;
    const limit = 1000;
    for (let guard = 0; guard < 50; guard++) {
      const { ok, status, json } = await ozonFetch(creds, '/v2/posting/fbo/list', {
        dir: 'ASC',
        filter: { since: dateFrom.toISOString(), to: dateTo.toISOString() },
        limit,
        offset,
      });
      if (!ok) {
        errors.push(`FBO: ${ozonErrorMessage(status, json)}`);
        break;
      }
      const postings: any[] = json?.result ?? [];
      for (const p of postings) if (p?.posting_number) postingNumbers.add(String(p.posting_number));
      if (postings.length < limit) break;
      offset += limit;
    }
  }

  return { postingNumbers: [...postingNumbers], errors };
}

/** Ищет массив операций в ответе — формат ответа у нового метода не задокументирован публично на 100%, поэтому проверяем несколько вероятных мест. */
function extractOperationsArray(json: any): any[] | null {
  const candidates = [
    json?.result,
    json?.result?.operations,
    json?.result?.postings,
    json?.result?.items,
    json?.postings,
    json?.operations,
    json?.items,
  ];
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
 * (возвращает "obsolete method cannot be used"). Его замена — /v1/finance/accrual/postings —
 * устроена иначе: принимает не диапазон дат, а конкретный список номеров отправлений
 * (posting_numbers, не больше 200 за раз). Поэтому сначала собираем номера отправлений
 * за период через стабильные методы списков FBS/FBO, а затем батчами запрашиваем по
 * ним начисления.
 *
 * Разбор ответа сделан защитно: если формат ответа не совпадёт с ожидаемым — синхронизация
 * не притворится «успешной с нулём операций», а вернёт ok:false с диагностикой реальной
 * структуры ответа, чтобы это было видно в интерфейсе и можно было быстро донастроить
 * сопоставление полей.
 */
export async function fetchOzonFinanceTransactions(
  creds: OzonCredentials,
  dateFrom: Date,
  dateTo: Date,
): Promise<OzonSyncResult> {
  const operations: OzonOperation[] = [];

  const { postingNumbers, errors: postingErrors } = await fetchPostingNumbers(creds, dateFrom, dateTo);
  if (postingNumbers.length === 0) {
    if (postingErrors.length > 0) {
      return { ok: false, message: `Не удалось получить список отправлений: ${postingErrors.join('; ')}`, operations };
    }
    return { ok: true, message: 'За период нет отправлений (заказов) — операций для загрузки нет.', operations };
  }

  let unrecognizedSample: string | null = null;
  let rawItemsSeen = 0;

  for (const batch of chunkArray(postingNumbers, 200)) {
    const { ok, status, json } = await ozonFetch(creds, '/v1/finance/accrual/postings', {
      posting_numbers: batch,
    });
    if (!ok) {
      return { ok: false, message: ozonErrorMessage(status, json), operations };
    }
    const rawList = extractOperationsArray(json);
    if (rawList === null) {
      if (!unrecognizedSample) unrecognizedSample = shortJsonPreview(json);
      continue;
    }
    rawItemsSeen += rawList.length;
    for (const raw of rawList) {
      const normalized = normalizeOperation(raw);
      if (normalized) operations.push(normalized);
      else if (!unrecognizedSample && raw && typeof raw === 'object') {
        // Нашли массив, но не смогли распознать в его элементах ни одной операции —
        // вероятно, элементы вложенные (например, начисления сгруппированы по
        // отправлению), а не плоский список операций. Не подставляем тихо 0 — фиксируем пример.
        unrecognizedSample = shortJsonPreview({ note: 'элемент массива не распознан как операция', item: raw });
      }
    }
  }

  if (rawItemsSeen > 0 && operations.length === 0 && unrecognizedSample) {
    return {
      ok: false,
      message: `Ozon вернул данные (${rawItemsSeen} элементов), но их формат не распознан — нужна донастройка интеграции. Отправлений найдено: ${postingNumbers.length}. Пример элемента: ${unrecognizedSample}`,
      operations,
    };
  }

  if (unrecognizedSample) {
    return {
      ok: false,
      message: `Ozon вернул ответ в незнакомом формате — нужна донастройка интеграции. Отправлений найдено: ${postingNumbers.length}. Структура ответа: ${unrecognizedSample}`,
      operations,
    };
  }

  const notePosting = postingErrors.length > 0 ? ` (не удалось проверить часть отправлений: ${postingErrors.join('; ')})` : '';
  return { ok: true, message: `Отправлений за период: ${postingNumbers.length}. Загружено операций: ${operations.length}${notePosting}`, operations };
}
