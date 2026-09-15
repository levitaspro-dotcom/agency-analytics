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
  /** Ozon SKU товара, к которому относится эта строка начисления (если есть) — используется для привязки операции к карточке товара. */
  sku?: string;
  /** Количество единиц товара в этой строке начисления — нужно, чтобы посчитать себестоимость проданного (quantity × Product.costPrice), которую сам Ozon не знает. */
  quantity?: number;
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

/**
 * Реальный формат ответа /v1/finance/accrual/postings (подтверждён по фактическому
 * ответу Ozon, не по документации — публичного описания на момент написания не было):
 *
 *   { "posting_accruals": [
 *       { "posting_number": "15156597-0481-1",
 *         "accruals": [
 *           { "type_id": 38, "accrued": { "amount": "-5", "currency": "RUB" },
 *             "accrual_date": "2026-09-09", "seller_price": null, "sku": 4775166327, "quantity": 1 },
 *           ...
 *         ] },
 *       ...
 *   ] }
 *
 * Оставляем немного альтернативных мест на случай, если Ozon поменяет обёртку без
 * изменения внутренней структуры.
 */
function extractPostingAccruals(json: any): any[] | null {
  const candidates = [json?.posting_accruals, json?.result?.posting_accruals, json?.result, json?.postings, json?.result?.postings];
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

/**
 * Справочник названий типов начислений (/v1/finance/accrual/types). Лучшее из
 * возможного: если запрос не удастся или формат окажется иным — просто покажем
 * числовой код типа вместо названия, на деньгах это никак не сказывается. Если
 * распознать список не удалось, возвращаем короткий диагностический фрагмент
 * ответа, чтобы можно было быстро донастроить сопоставление полей.
 */
async function fetchAccrualTypeNames(creds: OzonCredentials): Promise<{ map: Map<number, string>; diagnostic: string | null }> {
  const map = new Map<number, string>();
  try {
    const { ok, status, json } = await ozonFetch(creds, '/v1/finance/accrual/types', { language: 'RU' });
    if (!ok) return { map, diagnostic: `запрос не удался (${status})` };

    // Вариант 1: список объектов [{ type_id/id, name/title/... }]
    const listCandidates = [json?.result, json?.result?.types, json?.types, json?.accrual_types, json];
    let list: any[] | null = null;
    for (const c of listCandidates) {
      if (Array.isArray(c)) {
        list = c;
        break;
      }
    }
    if (list) {
      for (const t of list) {
        const id = t?.type_id ?? t?.id ?? t?.code;
        const name = t?.name ?? t?.name_ru ?? t?.title ?? t?.title_ru ?? t?.type_name ?? t?.description;
        if (id !== undefined && id !== null && name) map.set(Number(id), String(name));
      }
      if (map.size > 0) return { map, diagnostic: null };
    }

    // Вариант 2: объект-словарь { "38": "Название", ... }
    const dictCandidates = [json?.result, json?.types, json?.accrual_types, json];
    for (const d of dictCandidates) {
      if (d && typeof d === 'object' && !Array.isArray(d)) {
        for (const [k, v] of Object.entries(d)) {
          const id = Number(k);
          if (!Number.isNaN(id) && typeof v === 'string') map.set(id, v);
        }
        if (map.size > 0) return { map, diagnostic: null };
      }
    }

    return { map, diagnostic: shortJsonPreview(json) };
  } catch (e) {
    return { map, diagnostic: `исключение: ${(e as Error).message}` };
  }
}

/**
 * Разворачивает вложенную структуру (отправление -> список начислений) в плоский
 * список операций нашего внутреннего формата. Каждая строка начисления Ozon уже
 * содержит один знаковый (+/-) итог, поэтому категоризация «выручка / комиссия»
 * делается по знаку: положительное начисление — доход, отрицательное — расход
 * (совпадает по смыслу с прежней логикой accrual/net/fee на стороне вызывающего кода).
 */
function flattenPostingAccruals(postingAccruals: any[], typeNames: Map<number, string>): OzonOperation[] {
  const rows: OzonOperation[] = [];
  for (const posting of postingAccruals) {
    if (!posting || typeof posting !== 'object') continue;
    const postingNumber = posting.posting_number ?? '';
    const accruals: any[] = Array.isArray(posting.accruals) ? posting.accruals : [];
    for (const a of accruals) {
      if (!a || typeof a !== 'object') continue;
      const operation_date = a.accrual_date ?? a.date;
      if (!operation_date) continue;
      const typeId = a.type_id;
      const amountRaw = a.accrued?.amount ?? a.amount;
      const amount = Number(amountRaw) || 0;
      const operation_type_name =
        (typeId !== undefined && typeNames.get(Number(typeId))) || `Тип начисления ${typeId ?? '?'}`;
      rows.push({
        operation_id: `${postingNumber}:${typeId ?? ''}:${operation_date}:${a.sku ?? ''}`,
        operation_type: String(typeId ?? 'unknown'),
        operation_type_name,
        operation_date,
        accruals_for_sale: amount > 0 ? amount : 0,
        amount,
        sku: a.sku !== undefined && a.sku !== null ? String(a.sku) : undefined,
        quantity: Number.isFinite(Number(a.quantity)) && Number(a.quantity) > 0 ? Number(a.quantity) : undefined,
      });
    }
  }
  return rows;
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

  const { map: typeNames, diagnostic: typeNamesDiagnostic } = await fetchAccrualTypeNames(creds);
  let unrecognizedSample: string | null = null;
  let postingsWithAccrualsSeen = 0;

  for (const batch of chunkArray(postingNumbers, 200)) {
    const { ok, status, json } = await ozonFetch(creds, '/v1/finance/accrual/postings', {
      posting_numbers: batch,
    });
    if (!ok) {
      return { ok: false, message: ozonErrorMessage(status, json), operations };
    }
    const postingAccruals = extractPostingAccruals(json);
    if (postingAccruals === null) {
      if (!unrecognizedSample) unrecognizedSample = shortJsonPreview(json);
      continue;
    }
    postingsWithAccrualsSeen += postingAccruals.length;
    operations.push(...flattenPostingAccruals(postingAccruals, typeNames));
  }

  if (postingsWithAccrualsSeen > 0 && operations.length === 0 && !unrecognizedSample) {
    // Массив отправлений распознан, но ни в одном не нашлось строк начислений —
    // либо у этих отправлений правда ещё нет начислений, либо формат вложенных
    // accruals[] изменился. Не показываем тихий ноль — просим прислать пример.
    return {
      ok: false,
      message: `Получено ${postingsWithAccrualsSeen} отправлений (из ${postingNumbers.length} за период), но ни одной строки начисления в них не найдено — возможно, формат вложенного accruals[] изменился. Нужна проверка.`,
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
  const noteTypeNames = typeNamesDiagnostic ? ` · названия категорий не распознаны (${typeNamesDiagnostic})` : '';
  return {
    ok: true,
    message: `Отправлений за период: ${postingNumbers.length}. Загружено операций: ${operations.length}${notePosting}${noteTypeNames}`,
    operations,
  };
}

export interface OzonProduct {
  /** Числовой SKU Ozon для отображения. */
  sku: string;
  /** Все известные варианты SKU этого товара (обычный/FBO/FBS) — начисления могут нести любой из них, поэтому сопоставляем по всем сразу, а не только по одному «главному». */
  skuAliases: string[];
  offerId: string;
  name: string;
  sellPrice: number;
}

export interface OzonProductsResult {
  ok: boolean;
  message: string;
  products: OzonProduct[];
}

/**
 * Забирает каталог товаров магазина: артикул (offer_id), Ozon SKU, название и текущую
 * цену продажи. Себестоимость Ozon не знает в принципе — это поле в приложении всегда
 * заполняется вручную и синхронизацией никогда не перезаписывается.
 *
 * В отличие от финансового API, методы списка товаров (/v3/product/list) и цен
 * (/v5/product/info/prices) стабильные и давно не менялись, поэтому здесь меньше
 * неопределённости, чем в начислениях. Название товара — необязательный бонус:
 * если его не удалось получить, используем артикул как отображаемое имя, это не
 * влияет на суммы.
 */
export async function fetchOzonProducts(creds: OzonCredentials): Promise<OzonProductsResult> {
  const items: { productId: string; offerId: string }[] = [];
  {
    let lastId = '';
    for (let guard = 0; guard < 100; guard++) {
      const { ok, status, json } = await ozonFetch(creds, '/v3/product/list', {
        filter: {},
        last_id: lastId,
        limit: 1000,
      });
      if (!ok) return { ok: false, message: ozonErrorMessage(status, json), products: [] };
      const list: any[] = json?.result?.items ?? [];
      for (const it of list) {
        if (it?.offer_id !== undefined) items.push({ productId: String(it.product_id ?? ''), offerId: String(it.offer_id) });
      }
      const nextLastId = json?.result?.last_id;
      if (!nextLastId || list.length === 0) break;
      lastId = nextLastId;
    }
  }

  if (items.length === 0) {
    return { ok: true, message: 'В магазине пока нет товаров на Ozon.', products: [] };
  }

  const priceByOfferId = new Map<string, { skus: string[]; sellPrice: number }>();
  for (const batch of chunkArray(items.map((i) => i.offerId), 1000)) {
    let cursor = '';
    for (let guard = 0; guard < 20; guard++) {
      const { ok, status, json } = await ozonFetch(creds, '/v5/product/info/prices', {
        filter: { offer_id: batch },
        cursor,
        limit: 1000,
      });
      if (!ok) return { ok: false, message: ozonErrorMessage(status, json), products: [] };
      const list: any[] = json?.items ?? json?.result?.items ?? [];
      for (const it of list) {
        const offerId = it?.offer_id !== undefined ? String(it.offer_id) : undefined;
        const sellPrice = Number(it?.price?.price ?? it?.price ?? 0) || 0;
        const skus = [it?.sku, it?.fbo_sku, it?.fbs_sku]
          .filter((v) => v !== undefined && v !== null && v !== 0)
          .map((v) => String(v));
        if (offerId) priceByOfferId.set(offerId, { skus, sellPrice });
      }
      const nextCursor = json?.cursor ?? json?.result?.cursor;
      if (!nextCursor || list.length === 0) break;
      cursor = nextCursor;
    }
  }

  const nameByOfferId = new Map<string, string>();
  const extraSkusByOfferId = new Map<string, string[]>();
  for (const batch of chunkArray(items.map((i) => i.productId).filter(Boolean), 1000)) {
    const { ok, json } = await ozonFetch(creds, '/v3/product/info/list', { product_id: batch });
    if (!ok) continue; // название и доп. SKU — не критично для денег, при неудаче остаётся то, что уже есть
    const list: any[] = json?.result?.items ?? json?.items ?? [];
    for (const it of list) {
      const offerId = it?.offer_id !== undefined ? String(it.offer_id) : undefined;
      if (!offerId) continue;
      const name = it?.name;
      if (name) nameByOfferId.set(offerId, String(name));
      const skus = [it?.sku, it?.fbo_sku, it?.fbs_sku]
        .filter((v) => v !== undefined && v !== null && v !== 0)
        .map((v) => String(v));
      if (skus.length > 0) extraSkusByOfferId.set(offerId, skus);
    }
  }

  const products: OzonProduct[] = items.map((it) => {
    const priceInfo = priceByOfferId.get(it.offerId);
    const skuAliases = Array.from(new Set([...(priceInfo?.skus ?? []), ...(extraSkusByOfferId.get(it.offerId) ?? [])]));
    return {
      sku: skuAliases[0] ?? it.offerId,
      skuAliases: skuAliases.length > 0 ? skuAliases : [it.offerId],
      offerId: it.offerId,
      name: nameByOfferId.get(it.offerId) ?? it.offerId,
      sellPrice: priceInfo?.sellPrice ?? 0,
    };
  });

  return { ok: true, message: `Товаров получено: ${products.length}`, products };
}
