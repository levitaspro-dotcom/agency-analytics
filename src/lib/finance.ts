import { prisma } from './prisma';
import type { TransactionType } from '@prisma/client';
import { previousPeriod } from './period';
import { translateCategory } from './categoryLabels';

export type CategoryBreakdown = { category: string; amount: number }[];

export interface FinanceSummary {
  revenue: number;
  /** Все сборы и комиссии Ozon ЗА ПЕРИОД, включая рекламу (для обратной совместимости с местами,
   *  где расходы Ozon считаются одной суммой — /expenses, /reports, /agency, ИИ-аналитик). Для
   *  отображения на дашборде, где рекламу показывают отдельным шагом, используйте
   *  ozonFeesExclAds + adSpend (в сумме дают то же самое, что и ozonFees). */
  ozonFees: number;
  cogs: number;
  externalExpenses: number;
  taxes: number;
  totalExpenses: number;
  profit: number;
  margin: number; // 0..1
  byType: Record<TransactionType, CategoryBreakdown>;
  /** Ставка налога проекта (%), если задана — только для отображения рядом с суммой налога. */
  taxRatePercent: number;
  /** Расходы на рекламу (клики, продвижение заказов, продвижение бренда) — подмножество OZON_FEE,
   *  уже включённое в ozonFees/totalExpenses/profit выше (не считать отдельно поверх них!). Выделено
   *  для дашборда, где рекламу показывают отдельным шагом цепочки. */
  adSpend: number;
  adSpendCategories: CategoryBreakdown;
  /** Комиссии и сборы Ozon БЕЗ рекламы: ozonFees минус adSpend. Тоже подмножество, уже включённое
   *  в totalExpenses/profit — только для отображения. */
  ozonFeesExclAds: number;
  ozonFeesExclAdsCategories: CategoryBreakdown;
}

export type DateBasis = 'order' | 'accrual';

/**
 * Период можно считать по двум разным датам: «по дате заказа» (когда покупатель оформил
 * заказ — так исторически считало приложение) или «по дате начисления Ozon» (когда площадка
 * фактически провела начисление по отправлению — так считают официальные отчёты Ozon,
 * например «Отчёт по начислениям», и начисление обычно приходит на несколько дней позже
 * оформления заказа).
 *
 * В режиме «начисления» строки БЕЗ accrualDate (Ozon по этому отправлению ещё не провёл
 * начисление) в подсчёт не попадают — намеренно, а не по недосмотру: в официальном отчёте
 * Ozon за тот же период их тоже не будет, начисления ещё не произошло. Раньше здесь был
 * запасной вариант «нет даты начисления — считаем по дате заказа», но это как раз и приводило
 * к расхождению с отчётами Ozon: свежие заказы (последних дней перед концом периода) почти
 * всегда ещё не начислены, и с запасным вариантом попадали в подсчёт по дате заказа, раздувая
 * количество сверх того, что показывает сам Ozon. Проверено на реальном примере (экспорт
 * Ольги за 01.09–17.09.2026): без запасного варианта количество по Киселям совпало с отчётом
 * Ozon (5 и 7 шт), с запасным — было 13 и 17. Как только Ozon проведёт начисление и магазин
 * пересинхронизируется, строка появится в периоде начисления сама.
 */
export function dateWhere(basis: DateBasis, from: Date, to: Date) {
  if (basis === 'order') return { date: { gte: from, lte: to } };
  return { accrualDate: { gte: from, lte: to } };
}

function sumByCategory(rows: { category: string; amount: number }[]): CategoryBreakdown {
  const map = new Map<string, number>();
  // translateCategory — на случай, если в базе ещё остались старые операции с английским кодом
  // категории (сохранённые до того, как ozon.ts начал переводить их при синхронизации сам) —
  // так они «сливаются» в одну строку с уже переведёнными новыми операциями той же категории,
  // а не показываются отдельной строкой на английском.
  for (const r of rows) {
    const category = translateCategory(r.category);
    map.set(category, (map.get(category) ?? 0) + r.amount);
  }
  return Array.from(map.entries())
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

export async function computeFinanceSummary(params: {
  projectId: string;
  storeId?: string;
  from: Date;
  to: Date;
  dateBasis?: DateBasis;
}): Promise<FinanceSummary> {
  const { projectId, storeId, from, to, dateBasis = 'order' } = params;
  const [rows, project] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: {
        projectId,
        ...(storeId ? { storeId } : {}),
        ...dateWhere(dateBasis, from, to),
      },
      select: { type: true, category: true, amount: true },
    }),
    prisma.project.findUnique({ where: { id: projectId }, select: { taxRatePercent: true } }),
  ]);

  const byTypeRaw: Record<string, { category: string; amount: number }[]> = {
    REVENUE: [],
    OZON_FEE: [],
    COGS: [],
    EXTERNAL_EXPENSE: [],
    TAX: [],
  };
  for (const r of rows) byTypeRaw[r.type].push({ category: r.category, amount: r.amount });

  const revenue = byTypeRaw.REVENUE.reduce((s, r) => s + r.amount, 0);
  const ozonFees = byTypeRaw.OZON_FEE.reduce((s, r) => s + r.amount, 0);
  // Реклама — подмножество OZON_FEE (клики, продвижение заказов, продвижение бренда), выделяем
  // тем же bucketFineCategory(), что уже используется в computeDailyCalendar. adSpend + ozonFeesExclAds
  // = ozonFees всегда, это просто разбивка одной и той же суммы для отображения на дашборде.
  const adSpendRows: { category: string; amount: number }[] = [];
  const ozonFeesExclAdsRows: { category: string; amount: number }[] = [];
  for (const r of byTypeRaw.OZON_FEE) {
    const bucket = bucketFineCategory(r.category);
    if (bucket === 'clicks' || bucket === 'orderAds' || bucket === 'brandPromo') {
      adSpendRows.push(r);
    } else {
      ozonFeesExclAdsRows.push(r);
    }
  }
  const adSpend = adSpendRows.reduce((s, r) => s + r.amount, 0);
  const ozonFeesExclAds = ozonFeesExclAdsRows.reduce((s, r) => s + r.amount, 0);
  const cogs = byTypeRaw.COGS.reduce((s, r) => s + r.amount, 0);
  const externalExpenses = byTypeRaw.EXTERNAL_EXPENSE.reduce((s, r) => s + r.amount, 0);
  const taxRatePercent = project?.taxRatePercent ?? 0;
  // Налог считаем по формуле «ставка × выручка» — детерминированно, по заданной вручную ставке,
  // а не тем, что якобы прислал Ozon (площадка налоги продавца не считает и не знает). Ручные
  // TAX-операции (если когда-нибудь появятся) складываются с расчётным налогом, а не заменяют его.
  const manualTaxes = byTypeRaw.TAX.reduce((s, r) => s + r.amount, 0);
  const computedTax = taxRatePercent > 0 ? revenue * (taxRatePercent / 100) : 0;
  const taxes = manualTaxes + computedTax;
  const totalExpenses = ozonFees + cogs + externalExpenses + taxes;
  const profit = revenue - totalExpenses;
  const margin = revenue > 0 ? profit / revenue : 0;

  const taxCategories = sumByCategory(byTypeRaw.TAX);
  if (computedTax > 0) taxCategories.push({ category: `Налог по ставке ${taxRatePercent}% от выручки`, amount: computedTax });

  const byType = {
    REVENUE: sumByCategory(byTypeRaw.REVENUE),
    OZON_FEE: sumByCategory(byTypeRaw.OZON_FEE),
    COGS: sumByCategory(byTypeRaw.COGS),
    EXTERNAL_EXPENSE: sumByCategory(byTypeRaw.EXTERNAL_EXPENSE),
    TAX: taxCategories,
  } as Record<TransactionType, CategoryBreakdown>;

  return {
    revenue,
    ozonFees,
    cogs,
    externalExpenses,
    taxes,
    totalExpenses,
    profit,
    margin,
    byType,
    taxRatePercent,
    adSpend,
    adSpendCategories: sumByCategory(adSpendRows),
    ozonFeesExclAds,
    ozonFeesExclAdsCategories: sumByCategory(ozonFeesExclAdsRows),
  };
}

export interface DailyCalendarEntry {
  /** Локальная полночь этого дня. Группировка идёт по дате ОФОРМЛЕНИЯ заказа (FinanceTransaction.date),
   *  а не по дате начисления Ozon — иначе у самых свежих дней в периоде клетки были бы почти
   *  всегда пустые (начисление обычно приходит на несколько дней позже заказа, см. dateWhere). */
  date: Date;
  /** Кол-во ЗАКАЗОВ (отправлений) за день — количество РАЗНЫХ posting_number среди REVENUE-строк
   *  с датой заказа в этот день (posting_number достаём из FinanceTransaction.externalId, формат
   *  "<postingNumber>:...", см. StalePostingRow в projects/page.tsx — тот же приём). Не то же самое,
   *  что «продано штук»: если в один заказ положили 2 единицы одного товара, это всё ещё 1 заказ,
   *  а не 2. Раньше здесь считалось количество проданных ШТУК (сумма quantity) — Ольга уточнила,
   *  что это не то, ей нужно именно число заказов, которые не совпадали с тем, что она видит в
   *  кабинете Ozon. */
  orderCount: number;
  /** Продано, шт — сумма quantity по тем же REVENUE-строкам (сколько единиц товара ушло за день,
   *  может быть больше orderCount, если в заказах бывает не по одной штуке). */
  unitsSold: number;
  /** Сумма заказов за день, ₽ — сумма amount по тем же REVENUE-строкам. */
  orderSum: number;
  /** Реклама за день, ₽ — та же формула, что и ProductExpenseDetail.adSpend (клик + оплата за
   *  заказ + продвижение бренда). */
  adSpend: number;
  /** Все расходы за день, ₽ — сборы Ozon (включая рекламу) + себестоимость + внешние расходы +
   *  налог. Та же формула, что и FinanceSummary.totalExpenses, применённая к одному дню. */
  totalExpenses: number;
  /** adSpend / orderSum за день («рекламный» ДРР). null, если заказов в этот день не было. */
  drrPercentAd: number | null;
  /** totalExpenses / orderSum за день («общий» ДРР — какую долю выручки дня съедают вообще все
   *  расходы, не только реклама). null, если заказов в этот день не было. */
  drrPercentTotal: number | null;
}

function dayKey(d: Date) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Календарная сетка «Обзора»: по одной клетке на календарный день периода (даже если в этот день
 * не было ни одной операции — тогда клетка с нулями, а не пропуск), с разбивкой заказов/расходов/
 * рекламы по дню. FBO/FBS-разбивка и возвраты (шт/₽) по дням сюда намеренно не включены — этих
 * данных пока нет по дням нигде в приложении (см. обсуждение с Ольгой) — это отдельный, более
 * трудоёмкий следующий шаг.
 */
export async function computeDailyCalendar(params: {
  projectId: string;
  storeId?: string;
  from: Date;
  to: Date;
}): Promise<DailyCalendarEntry[]> {
  const { projectId, storeId, from, to } = params;
  const [rows, project] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: {
        projectId,
        ...(storeId ? { storeId } : {}),
        date: { gte: from, lte: to },
      },
      select: { type: true, category: true, amount: true, quantity: true, date: true, externalId: true },
    }),
    prisma.project.findUnique({ where: { id: projectId }, select: { taxRatePercent: true } }),
  ]);
  const taxRatePercent = project?.taxRatePercent ?? 0;

  type Bucket = {
    postingNumbers: Set<string>;
    unitsSold: number;
    orderSum: number;
    adSpend: number;
    ozonFeesOther: number;
    cogs: number;
    externalExpenses: number;
    manualTaxes: number;
  };
  const emptyBucket = (): Bucket => ({
    postingNumbers: new Set<string>(),
    unitsSold: 0,
    orderSum: 0,
    adSpend: 0,
    ozonFeesOther: 0,
    cogs: 0,
    externalExpenses: 0,
    manualTaxes: 0,
  });
  const byDay = new Map<string, Bucket>();

  for (const r of rows) {
    const key = dayKey(r.date);
    let b = byDay.get(key);
    if (!b) {
      b = emptyBucket();
      byDay.set(key, b);
    }
    if (r.type === 'REVENUE') {
      b.orderSum += r.amount;
      b.unitsSold += r.quantity ?? 0;
      // externalId у REVENUE-строк — "<postingNumber>:<lineKey>:revenue" (см. projects/page.tsx),
      // posting_number у Ozon без двоеточий, поэтому первый сегмент до ':' — он и есть. Пусто/null
      // не должно встречаться у REVENUE-строк (заполняется при создании), но на всякий случай
      // просто не считаем такую строку отдельным заказом, а не падаем.
      if (r.externalId) {
        const postingNumber = r.externalId.split(':')[0];
        if (postingNumber) b.postingNumbers.add(postingNumber);
      }
    } else if (r.type === 'OZON_FEE') {
      const bucket = bucketFineCategory(r.category);
      if (bucket === 'clicks' || bucket === 'orderAds' || bucket === 'brandPromo') {
        b.adSpend += r.amount;
      } else {
        b.ozonFeesOther += r.amount;
      }
    } else if (r.type === 'COGS') {
      b.cogs += r.amount;
    } else if (r.type === 'EXTERNAL_EXPENSE') {
      b.externalExpenses += r.amount;
    } else if (r.type === 'TAX') {
      b.manualTaxes += r.amount;
    }
  }

  const result: DailyCalendarEntry[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cursor.getTime() <= last.getTime()) {
    const b = byDay.get(dayKey(cursor)) ?? emptyBucket();
    const computedTax = taxRatePercent > 0 ? b.orderSum * (taxRatePercent / 100) : 0;
    const taxes = b.manualTaxes + computedTax;
    const ozonFeesTotal = b.adSpend + b.ozonFeesOther;
    const totalExpenses = ozonFeesTotal + b.cogs + b.externalExpenses + taxes;
    result.push({
      date: new Date(cursor),
      orderCount: b.postingNumbers.size,
      unitsSold: b.unitsSold,
      orderSum: b.orderSum,
      adSpend: b.adSpend,
      totalExpenses,
      drrPercentAd: b.orderSum > 0 ? b.adSpend / b.orderSum : null,
      drrPercentTotal: b.orderSum > 0 ? totalExpenses / b.orderSum : null,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

/**
 * Ozon-категории расходов (OZON_FEE.category — как их называет сам Ozon в ответе
 * /v1/finance/accrual/types, иногда без перевода на русский) раскладываем в несколько
 * понятных групп для страницы «Товары». Это только группировка для отображения —
 * полный список исходных категорий по-прежнему виден на странице «Расходы».
 * Категории, которых Ozon пока не отдаёт через это API (реклама — отдельный Performance
 * API с другими ключами; хранение и эквайринг в текущих данных ни разу не встречались —
 * либо их нет у этих магазинов, либо нужен другой отчёт Ozon), сюда не включены.
 */
// Ключи — и исходные английские коды (старые операции, сохранённые до того, как ozon.ts начал
// переводить их сам при синхронизации), и их русский перевод из lib/categoryLabels.ts (новые
// операции сохраняются уже переведёнными) — иначе после перевода эти сборы молча уехали бы в
// «Прочие сборы Ozon» на странице «Товары», хотя раньше корректно попадали в свою группу.
const FEE_BUCKET_BY_CATEGORY: Record<string, 'commission' | 'logistics' | 'handling'> = {
  SaleCommission: 'commission',
  'Комиссия за продажу': 'commission',
  BrandCommission: 'commission',
  'Комиссия за бренд': 'commission',
  Logistic: 'logistics',
  Логистика: 'logistics',
  LastMileCourier: 'logistics',
  'Курьерская доставка (последняя миля)': 'logistics',
  ReturnFlowLogistic: 'logistics',
  'Логистика возврата': 'logistics',
  'Drop-Off Agent': 'logistics',
  'Приём отправления в пункте (Drop-off)': 'logistics',
  DeliveryToHandoverPlaceByOzon: 'logistics',
  'Доставка до места передачи Ozon': 'logistics',
  PackingFee: 'handling',
  Упаковка: 'handling',
  PackageCost: 'handling',
  'Стоимость упаковочных материалов': 'handling',
  PickUpPointReturnAcceptance: 'handling',
  'Приём возврата в пункте выдачи': 'handling',
};

function bucketFeeCategory(category: string): 'commission' | 'logistics' | 'handling' | 'other' {
  return FEE_BUCKET_BY_CATEGORY[category] ?? 'other';
}

export interface ProductInsight {
  id: string;
  name: string;
  sku: string;
  /** Товар есть в текущем каталоге Ozon этого магазина (не путать с «были продажи за период» ниже). */
  active: boolean;
  /** Продано штук за период — из состава заказа (posting.products[]), 0 — значит заказов не было. */
  quantitySold: number;
  revenue: number;
  /** Себестоимость проданного за период = quantitySold × текущая Product.costPrice (считается
   *  здесь же, а не берётся из сохранённых COGS-строк — см. комментарий в computeProductInsights). */
  cogsFromTx: number;
  /** Себестоимость ЕДИНИЦЫ товара (Product.costPrice как есть, без умножения на количество) —
   *  0, если ещё не введена. Для отображения формулы «кол-во × себестоимость» рядом со суммой. */
  costPrice: number;
  /** Комиссия Ozon за продажу и за бренд. */
  commissionFee: number;
  /** Логистика, последняя миля, логистика возврата, доставка/приём в пункте. */
  logisticsFee: number;
  /** Упаковка и обработка отправления (в т.ч. приём возврата в ПВЗ). */
  handlingFee: number;
  /** Прочие сборы Ozon, не попавшие в три группы выше (например, рассрочка). */
  otherFee: number;
  /** Налог по этому товару за период = выручка товара × ставка налога проекта (см. комментарий в
   *  computeProductInsights). 0, если ставка налога не задана в настройках проекта. */
  taxAmount: number;
  /** Ставка налога проекта (%) — для подписи рядом с суммой налога. */
  taxRatePercent: number;
  /** Сумма всех расходов по товару за период: себестоимость + все сборы Ozon + налог по товару. */
  totalExpenses: number;
  /** ТОВАРНАЯ НАЦЕНКА (не маржинальность — см. periodMargin ниже, это разные показатели по ТЗ,
   *  раздел 4): (цена − себестоимость) / цена, БЕЗ вычета комиссии, логистики и прочих сборов
   *  Ozon. null, если себестоимость ещё не введена — тогда её посчитать честно нельзя (не
   *  показываем в этом случае мнимые 100%). Считается по ТЕКУЩЕЙ цене товара в Ozon
   *  (Product.sellPrice, обновляется при каждой синхронизации), а не по цене, по которой товар
   *  реально продавался в выбранном периоде — Ozon часто меняет цену/скидки, поэтому это число
   *  может заметно отличаться от unitMarginPeriod ниже. Показывает «наценка, если продать по
   *  сегодняшней цене» — сама по себе ничего не говорит о прибыльности периода. */
  unitMargin: number | null;
  /** ТОВАРНАЯ НАЦЕНКА по фактической средней цене продажи за период (выручка / кол-во шт), а не
   *  по текущей цене Ozon — тоже без вычета сборов Ozon (см. unitMargin выше). null, если
   *  себестоимость не введена, либо за период не было продаж (не из чего считать среднюю цену). */
  unitMarginPeriod: number | null;
  periodProfit: number;
  /** НАСТОЯЩАЯ МАРЖИНАЛЬНОСТЬ по ТЗ (раздел 4): прибыль / выручка за период, ПОСЛЕ вычета
   *  себестоимости, всех сборов Ozon И налога по товару (periodProfit / revenue). null, если за
   *  период не было выручки (нечего делить). */
  periodMargin: number | null;
  flag: 'critical' | 'warning' | null;
  reason?: string;
}

export async function computeProductInsights(params: {
  projectId: string;
  storeId?: string;
  from: Date;
  to: Date;
  dateBasis?: DateBasis;
}): Promise<ProductInsight[]> {
  const { projectId, storeId, from, to, dateBasis = 'order' } = params;
  // active:true — не показываем товары, которых больше нет в текущем каталоге Ozon этого
  // магазина (сняты с продажи или остались от ранее подключённого другого Ozon-аккаунта).
  const [products, project] = await Promise.all([
    prisma.product.findMany({ where: { projectId, active: true, ...(storeId ? { storeId } : {}) } }),
    prisma.project.findUnique({ where: { id: projectId }, select: { taxRatePercent: true } }),
  ]);
  const taxRatePercent = project?.taxRatePercent ?? 0;
  const productIds = products.map((p) => p.id);

  const txs = productIds.length
    ? await prisma.financeTransaction.findMany({
        where: { projectId, productId: { in: productIds }, ...dateWhere(dateBasis, from, to) },
        select: { productId: true, type: true, amount: true, category: true, quantity: true },
      })
    : [];

  const revByProduct = new Map<string, number>();
  const qtyByProduct = new Map<string, number>();
  const feeByProduct = new Map<string, { commission: number; logistics: number; handling: number; other: number }>();
  const feeRow = (id: string) => {
    let row = feeByProduct.get(id);
    if (!row) {
      row = { commission: 0, logistics: 0, handling: 0, other: 0 };
      feeByProduct.set(id, row);
    }
    return row;
  };
  for (const t of txs) {
    if (!t.productId) continue;
    if (t.type === 'REVENUE') {
      revByProduct.set(t.productId, (revByProduct.get(t.productId) ?? 0) + t.amount);
      if (t.quantity) qtyByProduct.set(t.productId, (qtyByProduct.get(t.productId) ?? 0) + t.quantity);
    }
    if (t.type === 'OZON_FEE') {
      const row = feeRow(t.productId);
      row[bucketFeeCategory(t.category)] += t.amount;
    }
  }

  return products
    .map((p) => {
      const revenue = revByProduct.get(p.id) ?? 0;
      const quantitySold = qtyByProduct.get(p.id) ?? 0;
      // Себестоимость проданного считаем здесь же, напрямую — кол-во шт (уже точное, см.
      // qtyByProduct выше) × ТЕКУЩАЯ Product.costPrice, а не берём сумму сохранённых COGS-строк
      // из FinanceTransaction. Те COGS-строки досоздаются только на очередной синхронизации, и
      // если Ольга вводит/меняет себестоимость между синхронизациями, часть уже проданных штук
      // так и остаётся без COGS-строки до следующего «Синхронизировать» — «Итого расходов» тогда
      // тихо занижен, будто посчитан только по части проданного. Живой расчёт от кол-ва исключает
      // этот разрыв: себестоимость учитывается сразу для всех проданных в периоде штук.
      const costKnown = p.costPrice > 0;
      const cogsFromTx = costKnown ? quantitySold * p.costPrice : 0;
      const fees = feeByProduct.get(p.id) ?? { commission: 0, logistics: 0, handling: 0, other: 0 };
      const totalFees = fees.commission + fees.logistics + fees.handling + fees.other;
      // Налог по товару — по ставке проекта от выручки ИМЕННО этого товара за период (та же формула,
      // что и computedTax в computeFinanceSummary выше, только не от выручки всего магазина, а от
      // выручки конкретного товара). Ручные TAX-операции (если есть) сюда не входят — они не
      // привязаны к товару. Сумма налога по товарам может быть чуть меньше налога в «Все расходы» на
      // «Обзоре», если часть выручки не удалось привязать ни к одному товару (см. «Без привязки к
      // товару» на странице «Товары») — сама сумма при этом нигде не теряется.
      const taxAmount = taxRatePercent > 0 && revenue > 0 ? revenue * (taxRatePercent / 100) : 0;
      const totalExpenses = cogsFromTx + totalFees + taxAmount;
      const unitMargin = costKnown && p.sellPrice > 0 ? (p.sellPrice - p.costPrice) / p.sellPrice : null;
      const avgSalePrice = quantitySold > 0 ? revenue / quantitySold : null;
      const unitMarginPeriod = costKnown && avgSalePrice && avgSalePrice > 0 ? (avgSalePrice - p.costPrice) / avgSalePrice : null;
      const periodProfit = revenue - totalExpenses;
      const periodMargin = revenue > 0 ? periodProfit / revenue : null;
      let flag: 'critical' | 'warning' | null = null;
      let reason: string | undefined;
      if (!costKnown) {
        // Без введённой себестоимости маржу с единицы честно посчитать нельзя — не подставляем
        // 0 или 100%, а прямо просим ввести цифру, прежде чем на неё полагаться.
        flag = 'warning';
        reason = 'Себестоимость не указана — маржа с единицы не может быть посчитана';
      } else if (revenue > 0 && periodProfit < 0) {
        flag = 'critical';
        reason = 'Убыток за период: расходы на товар (себестоимость + сборы Ozon + налог) превышают выручку по нему';
      } else if (unitMargin !== null && unitMargin < 0.1) {
        flag = 'warning';
        reason = `Наценка с единицы (по цене Ozon) всего ${(unitMargin * 100).toFixed(1)}% — это не маржинальность, расходы Ozon сюда ещё не вычтены`;
      } else if (revenue === 0 && totalExpenses > 0) {
        flag = 'warning';
        reason = 'Есть расходы по товару без выручки за период';
      }
      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        active: p.active,
        quantitySold,
        revenue,
        cogsFromTx,
        costPrice: p.costPrice,
        commissionFee: fees.commission,
        logisticsFee: fees.logistics,
        handlingFee: fees.handling,
        otherFee: fees.other,
        taxAmount,
        taxRatePercent,
        totalExpenses,
        unitMargin,
        unitMarginPeriod,
        periodProfit,
        periodMargin,
        flag,
        reason,
      };
    })
    .sort((a, b) => (a.flag ? 0 : 1) - (b.flag ? 0 : 1) || a.periodProfit - b.periodProfit);
}

// Более мелкая разбивка OZON_FEE-категорий для подробной постатейной таблицы на «Расходах»
// (в отличие от FEE_BUCKET_BY_CATEGORY выше — той, что используется на «Товарах» и группирует
// сборы всего в 4 группы). Сумма всех корзин здесь по-прежнему равна totalFees из
// computeProductInsights — категория просто попадает в более узкую корзину, деньги никуда не
// исчезают и не задваиваются. Категории, для которых пока не встретилось ни одного реального
// примера в данных (эквайринг, хранение, утилизация, доп. обработка ОВХ, оплата за заказ, работа
// с отзывами) — сюда намеренно не вписаны угадыванием: как только Ozon пришлёт такую категорию,
// она ляжет в «Прочие сборы» ниже и будет видно, что появилось что-то новое, требующее разбора.
const FINE_BUCKET_BY_CATEGORY: Record<string, string> = {
  'Комиссия за продажу': 'commission',
  'Комиссия за бренд': 'commission',
  'Вознаграждение за продажу': 'commission',
  Логистика: 'logistics',
  'Курьерская доставка (последняя миля)': 'logistics',
  'Кросс-докинг': 'shipmentProcessing',
  'Приём отправления в пункте (Drop-off)': 'shipmentProcessing',
  'Обработка отправления Drop-off партнёрами': 'shipmentProcessing',
  'Обработка товара': 'shipmentProcessing',
  Упаковка: 'shipmentProcessing',
  'Стоимость упаковочных материалов': 'shipmentProcessing',
  'Доставка до места передачи Ozon': 'deliveryToPickupPoint',
  'Доставка до места выдачи': 'deliveryToPickupPoint',
  'Приём возврата в пункте выдачи': 'returnsProcessing',
  'Логистика возврата': 'reverseLogistics',
  'Штраф за просрочку отгрузки': 'sellerFault',
  'Отгрузка в нерекомендованный слот': 'sellerFault',
  'Оплата за клик': 'clicks',
  'Продвижение бренда': 'brandPromo',
};

/** Ключи корзин FINE_BUCKET_BY_CATEGORY + 'other' — единый список, чтобы нигде не разойтись. */
const FINE_BUCKET_KEYS = [
  'commission',
  'acquiring',
  'shipmentProcessing',
  'logistics',
  'deliveryToPickupPoint',
  'storage',
  'returnsProcessing',
  'reverseLogistics',
  'disposal',
  'ovhProcessing',
  'sellerFault',
  'clicks',
  'orderAds',
  'brandPromo',
  'reviews',
  'other',
] as const;
export type FineFeeBucket = (typeof FINE_BUCKET_KEYS)[number];

// translateCategory сначала — часть уже сохранённых строк (до того, как ozon.ts начал переводить
// категории сам при синхронизации) до сих пор лежит в базе на английском (SaleCommission и т.п.),
// а FINE_BUCKET_BY_CATEGORY выше ключи держит только русские. Без этого перевода такие строки
// молча уезжали бы в «Прочие сборы» вместо своей настоящей категории — ровно та же ошибка, что
// уже один раз ловили на FEE_BUCKET_BY_CATEGORY (см. комментарий там), решаем её здесь иначе —
// централизованно, одним вызовом translateCategory, а не повторным дублированием английских
// ключей в ещё одном словаре.
function bucketFineCategory(category: string): FineFeeBucket {
  return (FINE_BUCKET_BY_CATEGORY[translateCategory(category)] as FineFeeBucket) ?? 'other';
}

export interface ProductExpenseDetail extends ProductInsight {
  /** Средняя цена продажи за период = выручка / кол-во шт. null, если продаж не было. */
  avgSalePrice: number | null;
  /** Штрихкод — из отчёта о реализации (см. ProductRealizationMonth), только за уже закрытые месяцы. */
  barcode: string | null;
  /** Доставлено/возвращено штук — из отчёта о реализации, ТОЛЬКО за уже закрытые календарные
   *  месяцы, пересекающиеся с периодом. Если весь период приходится на ещё не закрытый месяц —
   *  оба поля null (не 0 — это не «доставлено ноль», а «данных ещё нет»). */
  deliveredQty: number | null;
  returnedQty: number | null;
  /** true, если период пересекается хотя бы с одним ещё НЕ закрытым месяцем — тогда
   *  доставлено/возвращено (и баллы/партнёрские программы ниже) заведомо неполные. */
  realizationPartial: boolean;
  /** Баллы покупателя, партнёрские программы банков, «Звёздные товары» — из отчёта о реализации, те
   *  же оговорки, что и у deliveredQty: null, если данных ещё нет (см. realizationPartial). */
  bonusAmount: number | null;
  bankCoinvestmentAmount: number | null;
  starsAmount: number | null;
  /** Мелкая разбивка сборов Ozon — см. FINE_BUCKET_BY_CATEGORY. Сумма всех значений равна
   *  commissionFee + logisticsFee + handlingFee + otherFee (те же исходные строки, просто
   *  разложены мельче). */
  fine: Record<FineFeeBucket, number>;
  /** Реклама = clicks + orderAds + brandPromo (оплата за клик + оплата за заказ + продвижение
   *  бренда) — «работа с отзывами» сюда намеренно не входит, это не медиа-размещение, а
   *  отдельная платная услуга. */
  adSpend: number;
  /** adSpend / revenue за период. null, если выручки не было. */
  drrPercent: number | null;
}

export async function computeProductExpenseDetail(params: {
  projectId: string;
  storeId?: string;
  from: Date;
  to: Date;
  dateBasis?: DateBasis;
}): Promise<ProductExpenseDetail[]> {
  const { projectId, storeId, from, to, dateBasis = 'order' } = params;
  const base = await computeProductInsights(params);
  const productIds = base.map((p) => p.id);
  if (productIds.length === 0) return [];

  const [feeTxs, realizationRows] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: { projectId, productId: { in: productIds }, type: 'OZON_FEE', ...(storeId ? { storeId } : {}), ...dateWhere(dateBasis, from, to) },
      select: { productId: true, category: true, amount: true },
    }),
    // Отчёт о реализации — помесячный, а не по произвольному периоду (см. ProductRealizationMonth) —
    // берём все месяцы, ХОТЬ ЧАСТИЧНО пересекающиеся с [from, to] за этим магазином/проектом.
    prisma.productRealizationMonth.findMany({
      where: {
        projectId,
        productId: { in: productIds },
        ...(storeId ? { storeId } : {}),
        OR: monthsOverlapping(from, to).map(({ year, month }) => ({ year, month })),
      },
      select: { productId: true, year: true, month: true, deliveredQty: true, returnedQty: true, bonusAmount: true, starsAmount: true, bankCoinvestmentAmount: true },
    }),
  ]);

  const fineByProduct = new Map<string, Record<FineFeeBucket, number>>();
  const emptyFine = (): Record<FineFeeBucket, number> => Object.fromEntries(FINE_BUCKET_KEYS.map((k) => [k, 0])) as Record<FineFeeBucket, number>;
  for (const t of feeTxs) {
    if (!t.productId) continue;
    const row = fineByProduct.get(t.productId) ?? emptyFine();
    row[bucketFineCategory(t.category)] += t.amount;
    fineByProduct.set(t.productId, row);
  }

  const realByProduct = new Map<string, { deliveredQty: number; returnedQty: number; bonusAmount: number; starsAmount: number; bankCoinvestmentAmount: number; monthsSeen: Set<string> }>();
  for (const r of realizationRows) {
    const row = realByProduct.get(r.productId) ?? { deliveredQty: 0, returnedQty: 0, bonusAmount: 0, starsAmount: 0, bankCoinvestmentAmount: 0, monthsSeen: new Set<string>() };
    row.deliveredQty += r.deliveredQty;
    row.returnedQty += r.returnedQty;
    row.bonusAmount += r.bonusAmount;
    row.starsAmount += r.starsAmount;
    row.bankCoinvestmentAmount += r.bankCoinvestmentAmount;
    row.monthsSeen.add(`${r.year}-${r.month}`);
    realByProduct.set(r.productId, row);
  }

  const barcodeByProduct = new Map<string, string | null>();
  {
    const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, barcode: true } });
    for (const p of products) barcodeByProduct.set(p.id, p.barcode);
  }

  const allMonths = monthsOverlapping(from, to);
  const monthsWithData = new Set(realizationRows.map((r) => `${r.year}-${r.month}`));
  const realizationPartial = allMonths.some(({ year, month }) => !monthsWithData.has(`${year}-${month}`));

  return base.map((p) => {
    const fine = fineByProduct.get(p.id) ?? emptyFine();
    const real = realByProduct.get(p.id);
    const avgSalePrice = p.quantitySold > 0 ? p.revenue / p.quantitySold : null;
    const adSpend = fine.clicks + fine.orderAds + fine.brandPromo;
    const drrPercent = p.revenue > 0 ? adSpend / p.revenue : null;
    return {
      ...p,
      avgSalePrice,
      barcode: barcodeByProduct.get(p.id) ?? null,
      deliveredQty: real ? real.deliveredQty : null,
      returnedQty: real ? real.returnedQty : null,
      realizationPartial,
      bonusAmount: real ? real.bonusAmount : null,
      bankCoinvestmentAmount: real ? real.bankCoinvestmentAmount : null,
      starsAmount: real ? real.starsAmount : null,
      fine,
      adSpend,
      drrPercent,
    };
  });
}

/** Все календарные месяцы (year, month), хотя бы частично пересекающиеся с [from, to]. */
function monthsOverlapping(from: Date, to: Date): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  for (let guard = 0; guard < 24 && cur <= end; guard++) {
    out.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() + 1 });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

export interface AttentionItem {
  title: string;
  detail: string;
  severity: 'critical' | 'warning';
  href?: string;
}

export async function computeAttention(params: {
  projectId: string;
  storeId?: string;
  from: Date;
  to: Date;
}): Promise<AttentionItem[]> {
  const { projectId, storeId, from, to } = params;
  const items: AttentionItem[] = [];

  const summary = await computeFinanceSummary(params);
  if (summary.profit < 0) {
    items.push({
      title: 'Прибыль за период отрицательная',
      detail: `Убыток ${Math.abs(summary.profit).toLocaleString('ru-RU')} ₽ за выбранный период`,
      severity: 'critical',
    });
  }

  const products = await computeProductInsights(params);
  const flagged = products.filter((p) => p.flag);
  for (const p of flagged.slice(0, 5)) {
    items.push({
      title: `Товар «${p.name}» требует внимания`,
      detail: p.reason ?? '',
      severity: p.flag === 'critical' ? 'critical' : 'warning',
      href: '/products',
    });
  }

  const prev = previousPeriod(from, to);
  const prevSummary = await computeFinanceSummary({ projectId, storeId, from: prev.from, to: prev.to });
  const currentCats = [...summary.byType.OZON_FEE, ...summary.byType.EXTERNAL_EXPENSE, ...summary.byType.COGS];
  const prevMap = new Map<string, number>();
  for (const c of [...prevSummary.byType.OZON_FEE, ...prevSummary.byType.EXTERNAL_EXPENSE, ...prevSummary.byType.COGS]) {
    prevMap.set(c.category, c.amount);
  }
  for (const c of currentCats) {
    const prevVal = prevMap.get(c.category) ?? 0;
    if (prevVal > 0 && c.amount > prevVal * 1.25 && c.amount - prevVal > prevVal * 0.1) {
      items.push({
        title: `Расходы «${c.category}» выросли`,
        detail: `${prevVal.toLocaleString('ru-RU')} ₽ → ${c.amount.toLocaleString('ru-RU')} ₽ по сравнению с предыдущим периодом такой же длины`,
        severity: 'warning',
        href: '/expenses',
      });
    }
  }

  return items;
}
