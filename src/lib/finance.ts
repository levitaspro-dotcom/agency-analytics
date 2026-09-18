import { prisma } from './prisma';
import type { TransactionType } from '@prisma/client';
import { previousPeriod } from './period';

export type CategoryBreakdown = { category: string; amount: number }[];

export interface FinanceSummary {
  revenue: number;
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
  for (const r of rows) map.set(r.category, (map.get(r.category) ?? 0) + r.amount);
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

  return { revenue, ozonFees, cogs, externalExpenses, taxes, totalExpenses, profit, margin, byType, taxRatePercent };
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
const FEE_BUCKET_BY_CATEGORY: Record<string, 'commission' | 'logistics' | 'handling'> = {
  SaleCommission: 'commission',
  BrandCommission: 'commission',
  Logistic: 'logistics',
  LastMileCourier: 'logistics',
  ReturnFlowLogistic: 'logistics',
  'Drop-Off Agent': 'logistics',
  DeliveryToHandoverPlaceByOzon: 'logistics',
  PackingFee: 'handling',
  PackageCost: 'handling',
  PickUpPointReturnAcceptance: 'handling',
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
  /** Сумма всех расходов по товару за период: себестоимость + все сборы Ozon. */
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
   *  себестоимости и всех сборов Ozon (periodProfit / revenue) — не путать с unitMargin/
   *  unitMarginPeriod выше (товарная наценка, без вычета расходов Ozon). Эти два показателя
   *  могут отличаться в разы: наценка 76% при этом реальная маржинальность может быть
   *  отрицательной, если расходы Ozon съели всю разницу. null, если за период не было выручки
   *  (нечего делить). */
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
  const products = await prisma.product.findMany({ where: { projectId, active: true, ...(storeId ? { storeId } : {}) } });
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
      const totalExpenses = cogsFromTx + totalFees;
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
        reason = 'Убыток за период: расходы на товар (себестоимость + сборы Ozon) превышают выручку по нему';
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
