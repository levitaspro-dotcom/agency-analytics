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
  const rows = await prisma.financeTransaction.findMany({
    where: {
      projectId,
      ...(storeId ? { storeId } : {}),
      date: { gte: from, lte: to },
    },
    select: { type: true, category: true, amount: true },
  });

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
  const taxes = byTypeRaw.TAX.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = ozonFees + cogs + externalExpenses + taxes;
  const profit = revenue - totalExpenses;
  const margin = revenue > 0 ? profit / revenue : 0;

  const byType = {
    REVENUE: sumByCategory(byTypeRaw.REVENUE),
    OZON_FEE: sumByCategory(byTypeRaw.OZON_FEE),
    COGS: sumByCategory(byTypeRaw.COGS),
    EXTERNAL_EXPENSE: sumByCategory(byTypeRaw.EXTERNAL_EXPENSE),
    TAX: sumByCategory(byTypeRaw.TAX),
  } as Record<TransactionType, CategoryBreakdown>;

  return { revenue, ozonFees, cogs, externalExpenses, taxes, totalExpenses, profit, margin, byType };
}

export interface ProductInsight {
  id: string;
  name: string;
  sku: string;
  revenue: number;
  cogsFromTx: number;
  unitMargin: number;
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
  const products = await prisma.product.findMany({ where: { projectId, ...(storeId ? { storeId } : {}) } });
  const productIds = products.map((p) => p.id);

  const txs = productIds.length
    ? await prisma.financeTransaction.findMany({
        where: { projectId, productId: { in: productIds }, date: { gte: from, lte: to } },
        select: { productId: true, type: true, amount: true },
      })
    : [];

  const revByProduct = new Map<string, number>();
  const cogsByProduct = new Map<string, number>();
  for (const t of txs) {
    if (!t.productId) continue;
    if (t.type === 'REVENUE') revByProduct.set(t.productId, (revByProduct.get(t.productId) ?? 0) + t.amount);
    if (t.type === 'COGS') cogsByProduct.set(t.productId, (cogsByProduct.get(t.productId) ?? 0) + t.amount);
  }

  return products
    .map((p) => {
      const revenue = revByProduct.get(p.id) ?? 0;
      const cogsFromTx = cogsByProduct.get(p.id) ?? 0;
      const unitMargin = p.sellPrice > 0 ? (p.sellPrice - p.costPrice) / p.sellPrice : 0;
      const periodProfit = revenue - cogsFromTx;
      let flag: 'critical' | 'warning' | null = null;
      let reason: string | undefined;
      if (revenue > 0 && periodProfit < 0) {
        flag = 'critical';
        reason = 'Убыток за период: расходы на товар превышают выручку по нему';
      } else if (unitMargin < 0.1) {
        flag = 'warning';
        reason = `Маржа с единицы всего ${(unitMargin * 100).toFixed(1)}%`;
      } else if (revenue === 0 && cogsFromTx > 0) {
        flag = 'warning';
        reason = 'Есть расходы по товару без выручки за период';
      }
      return { id: p.id, name: p.name, sku: p.sku, revenue, cogsFromTx, unitMargin, periodProfit, flag, reason };
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
