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
}): Promise<FinanceSummary> {
  const { projectId, storeId, from, to } = params;
  const [rows, project] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: {
        projectId,
        ...(storeId ? { storeId } : {}),
        date: { gte: from, lte: to },
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
  cogsFromTx: number;
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
  /** null, если себестоимость ещё не введена — тогда маржу с единицы посчитать честно нельзя (не показываем в этом случае мнимые 100%). */
  unitMargin: number | null;
  periodProfit: number;
  flag: 'critical' | 'warning' | null;
  reason?: string;
}

export async function computeProductInsights(params: {
  projectId: string;
  storeId?: string;
  from: Date;
  to: Date;
}): Promise<ProductInsight[]> {
  const { projectId, storeId, from, to } = params;
  // active:true — не показываем товары, которых больше нет в текущем каталоге Ozon этого
  // магазина (сняты с продажи или остались от ранее подключённого другого Ozon-аккаунта).
  const products = await prisma.product.findMany({ where: { projectId, active: true, ...(storeId ? { storeId } : {}) } });
  const productIds = products.map((p) => p.id);

  const txs = productIds.length
    ? await prisma.financeTransaction.findMany({
        where: { projectId, productId: { in: productIds }, date: { gte: from, lte: to } },
        select: { productId: true, type: true, amount: true, category: true, quantity: true },
      })
    : [];

  const revByProduct = new Map<string, number>();
  const cogsByProduct = new Map<string, number>();
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
    if (t.type === 'COGS') cogsByProduct.set(t.productId, (cogsByProduct.get(t.productId) ?? 0) + t.amount);
    if (t.type === 'OZON_FEE') {
      const row = feeRow(t.productId);
      row[bucketFeeCategory(t.category)] += t.amount;
    }
  }

  return products
    .map((p) => {
      const revenue = revByProduct.get(p.id) ?? 0;
      const cogsFromTx = cogsByProduct.get(p.id) ?? 0;
      const quantitySold = qtyByProduct.get(p.id) ?? 0;
      const fees = feeByProduct.get(p.id) ?? { commission: 0, logistics: 0, handling: 0, other: 0 };
      const totalFees = fees.commission + fees.logistics + fees.handling + fees.other;
      const totalExpenses = cogsFromTx + totalFees;
      const costKnown = p.costPrice > 0;
      const unitMargin = costKnown && p.sellPrice > 0 ? (p.sellPrice - p.costPrice) / p.sellPrice : null;
      const periodProfit = revenue - totalExpenses;
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
        reason = `Маржа с единицы всего ${(unitMargin * 100).toFixed(1)}%`;
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
        commissionFee: fees.commission,
        logisticsFee: fees.logistics,
        handlingFee: fees.handling,
        otherFee: fees.other,
        totalExpenses,
        unitMargin,
        periodProfit,
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
