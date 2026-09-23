/**
 * Минимальный клиент к Ozon Seller API.
 *
 * Реализован как отдельный, легко заменяемый модуль (аналогично слою ИИ-адаптеров):
 * вся специфика Ozon — здесь, остальное приложение работает с обычными
 * FinanceTransaction-записями и не знает деталей API площадки.
 *
 * Документация: https://docs.ozon.ru/api/seller/
 */

import { translateCategory } from '../categoryLabels';

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
  /**
   * Номер отправления, к которому относится начисление. Ozon отдаёт sku далеко не в
   * каждой строке начисления (у части сборов — например, части SaleCommission/Logistic
   * по некоторым отправлениям — sku в ответе просто нет), но posting_number есть всегда.
   * По нему можно найти состав этого отправления (posting.products[]) и привязать сбор
   * к товару даже без прямого sku — см. использование в syncStoreAction.
   */
  postingNumber?: string;
}

/**
 * Одна строка проданного товара внутри отправления (из /v3/posting/fbs/list и
 * /v2/posting/fbo/list — стабильных, давно не менявшихся методов списка заказов).
 * Используется как основной источник выручки: финансовый метод /v1/finance/accrual/postings
 * отдаёт только строки удержаний (комиссия, логистика и т.п.), а не сумму самой продажи —
 * см. комментарий у fetchOzonFinanceTransactions ниже.
 */
export interface OzonPostingProductLine {
  postingNumber: string;
  date: string;
  sku?: string;
  offerId?: string;
  name?: string;
  price: number;
  quantity: number;
  /** Статус отправления (posting.status): delivered / cancelled / delivering / awaiting_* и т.п. */
  status?: string;
}

export interface OzonSyncResult {
  ok: boolean;
  message: string;
  operations: OzonOperation[];
  productLines: OzonPostingProductLine[];
}

/** Разбивает массив на батчи фиксированного размера (Ozon принимает не больше 200 posting_numbers за один запрос). */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Достаёт строки проданных товаров прямо из отправления (posting.products[] — обычный,
 * давно стабильный формат заказа Ozon: артикул/sku, количество, цена за единицу). Именно
 * отсюда берём выручку, а не из финансового метода — см. комментарий у
 * fetchOzonFinanceTransactions. Дата — по времени поступления заказа в обработку
 * (in_process_at), с осторожным запасным вариантом на случай отсутствия поля.
 */
function extractProductLines(posting: any): OzonPostingProductLine[] {
  const postingNumber = posting?.posting_number ? String(posting.posting_number) : '';
  if (!postingNumber) return [];
  const date = posting?.in_process_at ?? posting?.shipment_date ?? posting?.created_at ?? new Date().toISOString();
  const items: any[] = Array.isArray(posting?.products) ? posting.products : [];
  const status = posting?.status ? String(posting.status) : undefined;
  const lines: OzonPostingProductLine[] = [];
  for (const it of items) {
    const price = Number(it?.price) || 0;
    const quantity = Number(it?.quantity) || 0;
    if (price <= 0 || quantity <= 0) continue;
    lines.push({
      postingNumber,
      date,
      sku: it?.sku !== undefined && it?.sku !== null ? String(it.sku) : undefined,
      offerId: it?.offer_id !== undefined && it?.offer_id !== null ? String(it.offer_id) : undefined,
      name: it?.name ? String(it.name) : undefined,
      price,
      quantity,
      status,
    });
  }
  return lines;
}

/**
 * Собирает номера отправлений (posting_number) и строки проданных товаров за период
 * через два стабильных, давно не менявшихся метода Ozon — отдельно FBS и FBO (у аккаунта
 * может быть задействована любая из схем или обе сразу). Тем же вызовом, которым раньше
 * доставали только номера отправлений для финансового API, теперь забираем и состав
 * заказа (products[]) — он уже есть в ответе, просто раньше не использовался.
 */
async function fetchPostingNumbers(
  creds: OzonCredentials,
  dateFrom: Date,
  dateTo: Date,
): Promise<{ postingNumbers: string[]; productLines: OzonPostingProductLine[]; errors: string[] }> {
  const postingNumbers = new Set<string>();
  const productLines: OzonPostingProductLine[] = [];
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
      for (const p of postings) {
        if (p?.posting_number) postingNumbers.add(String(p.posting_number));
        productLines.push(...extractProductLines(p));
      }
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
      for (const p of postings) {
        if (p?.posting_number) postingNumbers.add(String(p.posting_number));
        productLines.push(...extractProductLines(p));
      }
      if (postings.length < limit) break;
      offset += limit;
    }
  }

  return { postingNumbers: [...postingNumbers], productLines, errors };
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
        // Реальный формат ответа (проверено на живых данных): { id, name, description } —
        // "name" — это внутренний английский код Ozon (например "Acquiring", "PayPerClick"),
        // а человекочитаемое русское название — в "description" (например "Эквайринг",
        // "Оплата за клик"). Раньше здесь сначала брали "name" — на карточках товаров и в
        // «Расходах» вместо русских названий показывались английские коды.
        const name = t?.description ?? t?.name_ru ?? t?.title_ru ?? t?.name ?? t?.title ?? t?.type_name;
        // Если и "description" пуст, и остались только английские варианты — пробуем словарь
        // известных кодов (см. lib/categoryLabels.ts), прежде чем сдаться и сохранить английский.
        if (id !== undefined && id !== null && name) map.set(Number(id), translateCategory(String(name)));
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
        postingNumber: postingNumber || undefined,
      });
    }
  }
  return rows;
}

/** Все даты периода (включительно), в формате YYYY-MM-DD — для методов, принимающих один день за раз. */
function dateRangeDays(dateFrom: Date, dateTo: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(dateFrom.getUTCFullYear(), dateFrom.getUTCMonth(), dateFrom.getUTCDate()));
  const end = new Date(Date.UTC(dateTo.getUTCFullYear(), dateTo.getUTCMonth(), dateTo.getUTCDate()));
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Забирает «периодические» начисления Ozon — те, что НЕ привязаны ни к какому отправлению
 * (в ответе Ozon это accrued_category: "NON_ITEM"): реклама (оплата за клик), эквайринг,
 * доставка до места выдачи, кросс-докинг и подобные сборы. Метод /v1/finance/accrual/postings
 * выше в принципе не может их увидеть — он опрашивает начисления ПО КОНКРЕТНЫМ отправлениям,
 * а эти сборы к отправлениям не привязаны вовсе.
 *
 * Раньше эти категории нигде в приложении не отражались — обнаружено и подтверждено на
 * реальном примере (магазин ИННОВИО, сентябрь 2026): начисления с этими категориями
 * реально есть у Ozon, но ни разу не появлялись в «Расходах». Отдельно проверено и НЕ
 * подтверждено: баллы за скидки (программа лояльности покупателей) — по полному списку из
 * 124 типов начислений (/v1/finance/accrual/types) подходящей категории для них нет вообще;
 * похоже, это единственная категория, для которой у Ozon действительно нет API — остаётся
 * только ручной импорт официального xlsx-отчёта, если понадобится.
 *
 * Метод /v1/finance/accrual/by-day принимает один календарный день за раз, а не диапазон —
 * поэтому опрашиваем каждый день периода отдельно (при максимальном окне синхронизации в
 * 60 дней, см. syncStoreAction, — не больше 60 дополнительных запросов).
 *
 * Так же, как и у /v1/finance/accrual/postings, разбор сделан защитно: ошибка по
 * конкретному дню не обрушивает всю синхронизацию (основная выручка и посвязанные с
 * отправлениями сборы к этому моменту уже собраны), а просто не добавляет данные за этот
 * день — причина попадает в notes итогового сообщения.
 */
async function fetchNonItemAccruals(
  creds: OzonCredentials,
  dateFrom: Date,
  dateTo: Date,
  typeNames: Map<number, string>,
): Promise<{ operations: OzonOperation[]; errors: string[] }> {
  const operations: OzonOperation[] = [];
  const errors: string[] = [];
  for (const day of dateRangeDays(dateFrom, dateTo)) {
    const { ok, status, json } = await ozonFetch(creds, '/v1/finance/accrual/by-day', { date: day });
    if (!ok) {
      errors.push(`${day}: ${ozonErrorMessage(status, json)}`);
      continue;
    }
    const accruals: any[] = Array.isArray(json?.accruals) ? json.accruals : [];
    for (const a of accruals) {
      if (!a || a.accrued_category !== 'NON_ITEM') continue;
      const typeId = a.non_item_fee?.type_id;
      const amount = Number(a.total_amount?.amount ?? a.non_item_fee?.accrued?.amount) || 0;
      if (amount === 0) continue;
      const operation_date = a.date ?? day;
      const operation_type_name =
        (typeId !== undefined && typeNames.get(Number(typeId))) || `Тип начисления ${typeId ?? '?'}`;
      operations.push({
        operation_id: `nonitem:${a.accrual_id ?? `${day}:${typeId}`}`,
        operation_type: String(typeId ?? 'unknown'),
        operation_type_name,
        operation_date,
        accruals_for_sale: amount > 0 ? amount : 0,
        amount,
        // Намеренно без sku/postingNumber — эти начисления в принципе не привязаны к
        // конкретному товару или отправлению, поэтому ниже (в syncStoreAction) они лягут
        // в общие «Расходы»/«Обзор» без разбивки по товару, как и любая другая операция
        // без привязки — это не потеря данных, а честное отражение того, что сбор
        // периодический, а не позаказный.
      });
    }
  }
  return { operations, errors };
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
 * ним начисления. Отдельно, через /v1/finance/accrual/by-day (см. fetchNonItemAccruals
 * выше), добираем периодические начисления, которые ни к какому отправлению не привязаны
 * и поэтому methods/accrual/postings в принципе не видит — рекламу, эквайринг, доставку до
 * места выдачи и т.п.
 *
 * Разбор ответа сделан защитно: если формат ответа не совпадёт с ожидаемым — синхронизация
 * не притворится «успешной с нулём операций», а вернёт ok:false с диагностикой реальной
 * структуры ответа, чтобы это было видно в интерфейсе и можно было быстро донастроить
 * сопоставление полей.
 *
 * ВАЖНО про выручку: этот метод отдаёт только строки удержаний (комиссия, логистика,
 * эквайринг и т.п. — все со знаком минус) и не содержит надёжной строки с суммой самой
 * продажи. Поэтому сумму продаж (REVENUE) мы берём не отсюда, а из состава заказа
 * (posting.products[] — см. fetchPostingNumbers/extractProductLines), а этот метод отвечает
 * только за расходные категории (OZON_FEE).
 */
export async function fetchOzonFinanceTransactions(
  creds: OzonCredentials,
  dateFrom: Date,
  dateTo: Date,
  // Посторонние (вне [dateFrom, dateTo] по дате заказа) posting_number, для которых нужно
  // ДОЗАПРОСИТЬ начисления — см. комментарий у extraPostingNumbers в syncStoreAction
  // (projects/page.tsx): так закрываем «зависшие» продажи прошлых периодов, чья дата
  // начисления Ozon ещё не подтянулась. /v1/finance/accrual/postings принимает posting_number
  // без фильтра по дате — можно спросить про отправление любого возраста.
  extraPostingNumbers: string[] = [],
): Promise<OzonSyncResult> {
  const operations: OzonOperation[] = [];

  const { postingNumbers: freshPostingNumbers, productLines, errors: postingErrors } = await fetchPostingNumbers(creds, dateFrom, dateTo);
  const postingNumbers = Array.from(new Set([...freshPostingNumbers, ...extraPostingNumbers]));
  if (postingNumbers.length === 0) {
    if (postingErrors.length > 0) {
      return { ok: false, message: `Не удалось получить список отправлений: ${postingErrors.join('; ')}`, operations, productLines: [] };
    }
    return { ok: true, message: 'За период нет отправлений (заказов) — операций для загрузки нет.', operations, productLines: [] };
  }

  if (productLines.length === 0 && freshPostingNumbers.length > 0) {
    // Отправления есть, но ни в одном не нашлось состава заказа (products[]) — раньше
    // это поле не использовалось и могло незаметно поменять формат. Не показываем тихий
    // ноль по выручке — просим прислать пример для донастройки. Проверяем именно
    // freshPostingNumbers (найденные за [dateFrom, dateTo]), а не итоговый postingNumbers —
    // если за период вообще не было новых отправлений и мы здесь только из-за
    // extraPostingNumbers (дозапрос начислений для старых продаж, см. комментарий выше),
    // это не ошибка формата, а нормальный день без новых заказов.
    return {
      ok: false,
      message: `Отправлений за период: ${freshPostingNumbers.length}, но ни в одном не нашлось состава заказа (products[]) — не могу посчитать выручку. Нужна проверка формата ответа /v3/posting/fbs/list · /v2/posting/fbo/list.`,
      operations,
      productLines: [],
    };
  }

  const { map: typeNames, diagnostic: typeNamesDiagnostic } = await fetchAccrualTypeNames(creds);
  let unrecognizedSample: string | null = null;
  let postingsWithAccrualsSeen = 0;

  for (const batch of chunkArray(postingNumbers, 200)) {
    const { ok, status, json } = await ozonFetch(creds, '/v1/finance/accrual/postings', {
      posting_numbers: batch,
    });
    if (!ok) {
      return { ok: false, message: ozonErrorMessage(status, json), operations, productLines };
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
      productLines,
    };
  }

  if (unrecognizedSample) {
    return {
      ok: false,
      message: `Ozon вернул ответ в незнакомом формате — нужна донастройка интеграции. Отправлений найдено: ${postingNumbers.length}. Структура ответа: ${unrecognizedSample}`,
      operations,
      productLines,
    };
  }

  // Периодические начисления (реклама, эквайринг, доставка до места выдачи и т.п.) —
  // не привязаны к отправлению, поэтому добираются отдельным методом. Ошибка здесь не
  // должна ронять уже собранные выручку/себестоимость/позаказные сборы — только теряется
  // именно эта дополнительная категория, и это видно в notes ниже.
  const { operations: nonItemOps, errors: nonItemErrors } = await fetchNonItemAccruals(creds, dateFrom, dateTo, typeNames);
  operations.push(...nonItemOps);

  const notePosting = postingErrors.length > 0 ? ` (не удалось проверить часть отправлений: ${postingErrors.join('; ')})` : '';
  const noteTypeNames = typeNamesDiagnostic ? ` · названия категорий не распознаны (${typeNamesDiagnostic})` : '';
  const noteNonItem = nonItemErrors.length > 0 ? ` · периодические начисления получены не за все дни (${nonItemErrors.length} из ${dateRangeDays(dateFrom, dateTo).length} дней с ошибкой)` : '';
  const noteExtra = extraPostingNumbers.length > 0 ? ` · дозапрошено начислений по старым продажам: ${extraPostingNumbers.length}` : '';
  return {
    ok: true,
    message: `Отправлений за период: ${freshPostingNumbers.length}. Товарных строк (выручка): ${productLines.length}. Расходных операций: ${operations.length - nonItemOps.length}. Периодических начислений (реклама/эквайринг/доставка и т.п., не по отправлениям): ${nonItemOps.length}${notePosting}${noteTypeNames}${noteNonItem}${noteExtra}`,
    operations,
    productLines,
  };
}

export interface OzonRealizationRow {
  sku?: string;
  offerId?: string;
  barcode?: string;
  deliveredQty: number;
  returnedQty: number;
  bonusAmount: number;
  starsAmount: number;
  bankCoinvestmentAmount: number;
}

export interface OzonRealizationResult {
  /** true — отчёт получен и разобран (даже если пустой). false — либо месяц ещё не закрыт
   *  (Ozon пока не готов отдать отчёт), либо реальная ошибка запроса — в обоих случаях это
   *  НЕ должно останавливать остальную синхронизацию, см. message. */
  ok: boolean;
  message: string;
  rows: OzonRealizationRow[];
}

/**
 * «Позаказный отчёт о реализации» (/v1/finance/realization/posting) — единственный известный
 * метод Ozon Seller API, отдающий помесячно штрихкод товара и РЕАЛЬНО доставленное/возвращённое
 * количество, а также суммы по баллам покупателя и партнёрским программам банков — то, что через
 * /v1/finance/accrual/postings (основной источник сборов в этом приложении) получить нельзя в
 * принципе. Обратная сторона: Ozon формирует его только за уже завершённый календарный месяц,
 * обычно публикует не раньше 5 числа следующего — запрос за текущий/слишком свежий месяц штатно
 * возвращает пустой результат или ошибку, это НЕ признак поломки интеграции.
 *
 * Умышленно НЕ используем отсюда суммы комиссии/логистики (delivery_commission.commission и
 * т.п.) — они уже надёжно посчитаны через accrual/postings и сверены с отчётами Ozon (см. историю
 * lib/finance.ts); взяв их ещё раз отсюда, рисковали бы задвоить расходы, если два метода Ozon
 * разойдутся на копейки. Берём только то, чего больше неоткуда взять.
 */
export async function fetchRealizationReport(creds: OzonCredentials, year: number, month: number): Promise<OzonRealizationResult> {
  try {
    const { ok, status, json } = await ozonFetch(creds, '/v1/finance/realization/posting', { year, month });
    if (!ok) {
      // 400/404 здесь чаще всего означает «месяц ещё не закрыт» — не поднимаем как ошибку
      // синхронизации, просто сообщаем причину вызывающему коду.
      return { ok: false, message: `Отчёт за ${month}.${year} недоступен (${ozonErrorMessage(status, json)}) — вероятно, месяц ещё не закрыт Ozon`, rows: [] };
    }
    const rawRows: any[] = Array.isArray(json?.rows) ? json.rows : Array.isArray(json?.result?.rows) ? json.result.rows : [];
    if (rawRows.length === 0) {
      return { ok: true, message: `Отчёт за ${month}.${year}: строк нет (нет реализации за месяц или месяц ещё не закрыт)`, rows: [] };
    }

    // Один товар может встретиться в нескольких строках (несколько отправлений за месяц) —
    // складываем по sku/offer_id.
    const bySkuOffer = new Map<string, OzonRealizationRow>();
    for (const r of rawRows) {
      const item = r?.item ?? {};
      const sku = item?.sku !== undefined && item?.sku !== null && item.sku !== 0 ? String(item.sku) : undefined;
      const offerId = item?.offer_id !== undefined && item?.offer_id !== null ? String(item.offer_id) : undefined;
      const barcode = item?.barcode ? String(item.barcode) : undefined;
      const key = sku ?? offerId ?? 'unknown';
      const cur = bySkuOffer.get(key) ?? { sku, offerId, barcode, deliveredQty: 0, returnedQty: 0, bonusAmount: 0, starsAmount: 0, bankCoinvestmentAmount: 0 };
      const dc = r?.delivery_commission ?? {};
      const rc = r?.return_commission ?? {};
      cur.deliveredQty += Number(dc?.quantity) || 0;
      cur.returnedQty += Number(rc?.quantity) || 0;
      cur.bonusAmount += Math.abs(Number(dc?.bonus) || 0);
      cur.starsAmount += Math.abs(Number(dc?.stars) || 0);
      cur.bankCoinvestmentAmount += Math.abs(Number(dc?.bank_coinvestment) || 0);
      if (!cur.barcode && barcode) cur.barcode = barcode;
      bySkuOffer.set(key, cur);
    }

    return { ok: true, message: `Отчёт за ${month}.${year}: товарных позиций — ${bySkuOffer.size}`, rows: Array.from(bySkuOffer.values()) };
  } catch (e) {
    return { ok: false, message: `Не удалось получить отчёт за ${month}.${year}: ${(e as Error).message}`, rows: [] };
  }
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
