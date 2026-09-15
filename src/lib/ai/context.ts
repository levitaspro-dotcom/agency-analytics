import { computeFinanceSummary, computeProductInsights, computeAttention } from '../finance';
import { previousPeriod, formatDate } from '../period';
import { getProjectDataFreshness } from '../freshness';

export interface ProjectAiContext {
  /** Текст, который передаётся модели как контекст. Содержит только агрегированные
   *  цифры и названия категорий/товаров — никаких ключей, паролей, платёжных
   *  реквизитов или персональных данных покупателей здесь нет и быть не может,
   *  так как источник — те же детерминированные функции, что рисуют дашборд. */
  text: string;
  dataAsOf: Date | null;
  isStale: boolean;
}

function money(n: number) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

export async function buildProjectAiContext(params: {
  projectId: string;
  storeId?: string;
  from: Date;
  to: Date;
}): Promise<ProjectAiContext> {
  const { projectId, storeId, from, to } = params;
  const prev = previousPeriod(from, to);

  const [summary, prevSummary, products, attention, freshness] = await Promise.all([
    computeFinanceSummary({ projectId, storeId, from, to }),
    computeFinanceSummary({ projectId, storeId, from: prev.from, to: prev.to }),
    computeProductInsights({ projectId, storeId, from, to }),
    computeAttention({ projectId, storeId, from, to }),
    getProjectDataFreshness(projectId, storeId),
  ]);
  const { dataAsOf, isStale } = freshness;

  const lines: string[] = [];
  lines.push(`Период анализа: ${formatDate(from)} – ${formatDate(to)}.`);
  lines.push(
    `Данные актуальны на: ${dataAsOf ? dataAsOf.toLocaleString('ru-RU') : 'нет данных'}.` +
      (isStale ? ' ВНИМАНИЕ: данные не обновлялись более 3 суток, возможно устарели — предупреди об этом в ответе.' : ''),
  );
  lines.push('');
  lines.push('ФИНАНСОВАЯ СВОДКА (уже рассчитана детерминированным модулем, доверяй этим цифрам и не пересчитывай их сама/сам):');
  lines.push(`Выручка: ${money(summary.revenue)}`);
  lines.push(`Комиссии Ozon: ${money(summary.ozonFees)}`);
  lines.push(`Себестоимость (COGS): ${money(summary.cogs)}`);
  lines.push(`Внешние расходы: ${money(summary.externalExpenses)}`);
  lines.push(`Налоги: ${money(summary.taxes)}`);
  lines.push(`Прибыль: ${money(summary.profit)} (маржа ${(summary.margin * 100).toFixed(1)}%)`);
  lines.push('');
  lines.push('Расходы по категориям:');
  for (const t of ['OZON_FEE', 'COGS', 'EXTERNAL_EXPENSE', 'TAX'] as const) {
    const rows = summary.byType[t];
    if (rows.length) lines.push(`  ${t}: ` + rows.map((r) => `${r.category} — ${money(r.amount)}`).join('; '));
  }
  lines.push('');
  lines.push(`Для сравнения (предыдущий период такой же длины): выручка ${money(prevSummary.revenue)}, прибыль ${money(prevSummary.profit)}.`);

  const flagged = products.filter((p) => p.flag);
  if (flagged.length) {
    lines.push('');
    lines.push('Товары, требующие внимания:');
    for (const p of flagged) {
      lines.push(`  «${p.name}» (${p.sku}): ${p.reason} — прибыль по товару за период ${money(p.periodProfit)}`);
    }
  }

  if (attention.length) {
    lines.push('');
    lines.push('Автоматические сигналы «Требует внимания» (уже посчитаны, не придумывай новые без опоры на цифры выше):');
    for (const a of attention) lines.push(`  [${a.severity}] ${a.title}: ${a.detail}`);
  }

  return { text: lines.join('\n'), dataAsOf, isStale };
}
