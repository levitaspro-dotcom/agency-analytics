import { requireUser, listAccessibleProjects, assertProjectAccess } from '@/lib/authz';
import { resolvePeriod, formatDate } from '@/lib/period';
import { computeFinanceSummary, computeProductInsights, type CategoryBreakdown } from '@/lib/finance';
import { translateCategory } from '@/lib/categoryLabels';
import { prisma } from '@/lib/prisma';
import { FilterBar } from '@/components/FilterBar';

export const dynamic = 'force-dynamic';

// Группы — те же 4 типа операций, что и везде в приложении (FinanceTransaction.type), но с
// названиями для этой страницы: «Расходы по группам» ниже показывает их итогом, «Подробно по
// категориям» — детально внутри каждой группы.
const TYPE_LABEL: Record<string, string> = {
  OZON_FEE: 'Комиссии и сборы Ozon',
  COGS: 'Себестоимость товаров',
  EXTERNAL_EXPENSE: 'Внешние расходы',
  TAX: 'Налог',
};

function money(n: number) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: { projectId?: string; storeId?: string; from?: string; to?: string };
}) {
  const user = await requireUser();
  const projects = await listAccessibleProjects(user);
  if (projects.length === 0) return <div className="empty-state">Нет доступных магазинов.</div>;

  const projectId = searchParams.projectId && projects.some((p) => p.id === searchParams.projectId) ? searchParams.projectId : projects[0].id;
  await assertProjectAccess(user, projectId);
  const storeId = searchParams.storeId || undefined;
  const { from, to } = resolvePeriod(searchParams);

  // computeFinanceSummary — тот же расчёт, что и на «Обзоре»/«Отчётах»: суммы по категориям здесь
  // уже переведены на русский (см. translateCategory в lib/finance.ts) и, важно, здесь ЕСТЬ налог —
  // включая расчётный (ставка проекта × выручка), которого нет как отдельной сохранённой операции
  // (раньше эта страница считала категории сама, напрямую по FinanceTransaction, и расчётный налог
  // из-за этого никогда сюда не попадал).
  const summary = await computeFinanceSummary({ projectId, storeId, from, to });

  const groups: { key: keyof typeof TYPE_LABEL; label: string; amount: number; rows: CategoryBreakdown }[] = [
    { key: 'OZON_FEE', label: TYPE_LABEL.OZON_FEE, amount: summary.ozonFees, rows: summary.byType.OZON_FEE },
    { key: 'COGS', label: TYPE_LABEL.COGS, amount: summary.cogs, rows: summary.byType.COGS },
    { key: 'EXTERNAL_EXPENSE', label: TYPE_LABEL.EXTERNAL_EXPENSE, amount: summary.externalExpenses, rows: summary.byType.EXTERNAL_EXPENSE },
    { key: 'TAX', label: TYPE_LABEL.TAX, amount: summary.taxes, rows: summary.byType.TAX },
  ];
  const hasAnyExpenses = groups.some((g) => g.amount > 0);
  const hasComputedTax = summary.byType.TAX.some((r) => r.category.startsWith('Налог по ставке'));

  const rows = await prisma.financeTransaction.findMany({
    where: {
      projectId,
      ...(storeId ? { storeId } : {}),
      type: { in: ['OZON_FEE', 'COGS', 'EXTERNAL_EXPENSE', 'TAX'] },
      date: { gte: from, lte: to },
    },
    orderBy: { date: 'desc' },
    include: { product: true },
  });

  // Себестоимость проданных товаров за период, по каждому товару — считается «живьём» от кол-ва
  // проданных штук × текущей себестоимости (та же логика, что и на странице «Товары»), а не
  // берётся из сохранённых COGS-строк выше — так сумма не занижается, если себестоимость ввели
  // уже после последней синхронизации (см. комментарий в lib/finance.ts computeProductInsights).
  const productInsights = await computeProductInsights({ projectId, storeId, from, to, dateBasis: 'order' });
  const soldProducts = productInsights
    .filter((p) => p.quantitySold > 0)
    .sort((a, b) => b.cogsFromTx - a.cogsFromTx);
  const totalCogs = soldProducts.reduce((s, p) => s + p.cogsFromTx, 0);
  const totalTax = soldProducts.reduce((s, p) => s + p.taxAmount, 0);
  const totalQuantitySold = soldProducts.reduce((s, p) => s + p.quantitySold, 0);
  const missingCostCount = soldProducts.filter((p) => p.costPrice <= 0).length;

  return (
    <div>
      <FilterBar basePath="/expenses" projects={projects} selectedProjectId={projectId} selectedStoreId={storeId} from={from} to={to} />

      <div className="panel">
        <h2>Все расходы за период</h2>
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">Выручка</div>
            <div className="kpi-value">{money(summary.revenue)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">
              <span
                className="tooltip-hint"
                title="Сумма всех расходов за период по всем группам ниже: комиссии и сборы Ozon + себестоимость проданных товаров + внешние расходы + налог."
              >
                Все расходы
              </span>
            </div>
            <div className="kpi-value">{money(summary.totalExpenses)}</div>
            <div className="kpi-sub">по всем товарам магазина — разбивка по группам ниже</div>
          </div>
          <div className={`kpi-card ${summary.profit >= 0 ? 'positive' : 'negative'}`}>
            <div className="kpi-label">
              <span className="tooltip-hint" title="Выручка за период минус «Все расходы» (Ozon + себестоимость + внешние расходы + налог).">
                Прибыль после налога
              </span>
            </div>
            <div className="kpi-value">{money(summary.profit)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">
              <span className="tooltip-hint" title="Прибыль после налога за период, делённая на выручку за период (в процентах).">
                Маржинальность
              </span>
            </div>
            <div className="kpi-value">{(summary.margin * 100).toFixed(1)}%</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Расходы по группам</h2>
        {!hasAnyExpenses ? (
          <div className="empty-state">За период расходов нет.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Группа</th>
                <th>Сумма</th>
                <th>Доля от всех расходов</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td>{g.label}</td>
                  <td>{money(g.amount)}</td>
                  <td>{summary.totalExpenses > 0 ? ((g.amount / summary.totalExpenses) * 100).toFixed(1) + '%' : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 600, borderTop: '2px solid var(--border)' }}>
                <td>Итого — все расходы</td>
                <td>{money(summary.totalExpenses)}</td>
                <td>{summary.totalExpenses > 0 ? '100%' : '—'}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Подробно по категориям</h2>
        {!hasAnyExpenses ? (
          <div className="empty-state">За период расходов нет.</div>
        ) : (
          <>
            {groups.map(
              (g) =>
                g.rows.length > 0 && (
                  <div key={g.key} style={{ marginBottom: 20 }}>
                    <h3 style={{ fontSize: 14, marginBottom: 8 }}>
                      {g.label} — {money(g.amount)}
                    </h3>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Категория</th>
                          <th>Сумма</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.rows.map((r) => (
                          <tr key={r.category}>
                            <td>{r.category}</td>
                            <td>{money(r.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ),
            )}
            {hasComputedTax && (
              <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: -8 }}>
                «Налог по ставке X% от выручки» — расчётная величина (ставка налога проекта × выручка за период), а не
                отдельная сохранённая операция, поэтому такой строки не будет в «Исходных операциях» ниже.
              </p>
            )}
          </>
        )}
      </div>

      <div className="panel">
        <h2>Товары: себестоимость проданного за период</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: -8, marginBottom: 14 }}>
          Себестоимость проданного = кол-во проданных штук товара за период × его себестоимость. Например,
          13 продаж по 699 ₽ себестоимости = 13 × 699 ₽ = 9 087 ₽. Налог по товару = выручка по этому товару
          × ставка налога проекта (0 ₽, если ставка не задана в настройках). Сумма по каждому товару ниже, и
          общий итог — под таблицей. Показаны только товары с продажами за период; полный список товаров
          (включая без продаж) и подробности по каждому — на странице «Товары».
        </p>
        {missingCostCount > 0 && (
          <p style={{ color: 'var(--warn, #b58900)', fontSize: 12.5, marginTop: -8, marginBottom: 14 }}>
            У {missingCostCount} {missingCostCount === 1 ? 'товара' : 'товаров'} с продажами за период не указана
            себестоимость — их себестоимость проданного посчитана как 0 ₽ и НЕ включена в итог ниже. Ввести
            себестоимость можно на странице «Товары».
          </p>
        )}
        {soldProducts.length === 0 ? (
          <div className="empty-state">За период продаж нет.</div>
        ) : (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>SKU</th>
                  <th>Продано, шт</th>
                  <th>Себестоимость, ₽/шт</th>
                  <th>Себестоимость проданного, ₽</th>
                  <th>Выручка, ₽</th>
                  <th>Налог, ₽</th>
                  <th>Прибыль за период, ₽</th>
                </tr>
              </thead>
              <tbody>
                {soldProducts.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{p.sku}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.quantitySold}</td>
                    <td>{p.costPrice > 0 ? Math.round(p.costPrice).toLocaleString('ru-RU') + ' ₽' : '—'}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {p.costPrice > 0
                        ? `${p.quantitySold} × ${Math.round(p.costPrice).toLocaleString('ru-RU')} ₽ = ${Math.round(p.cogsFromTx).toLocaleString('ru-RU')} ₽`
                        : '—'}
                    </td>
                    <td>{Math.round(p.revenue).toLocaleString('ru-RU')} ₽</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {p.taxAmount > 0 ? Math.round(p.taxAmount).toLocaleString('ru-RU') + ' ₽' : p.taxRatePercent > 0 ? '0 ₽' : '—'}
                    </td>
                    <td style={{ color: p.periodProfit < 0 ? 'var(--bad)' : 'inherit' }}>
                      {Math.round(p.periodProfit).toLocaleString('ru-RU')} ₽
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600, borderTop: '2px solid var(--border)' }}>
                  <td>Итого</td>
                  <td></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{totalQuantitySold}</td>
                  <td></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(totalCogs).toLocaleString('ru-RU')} ₽</td>
                  <td></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(totalTax).toLocaleString('ru-RU')} ₽</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </>
        )}
      </div>

      <div className="panel">
        <h2>Исходные операции</h2>
        {rows.length === 0 ? (
          <div className="empty-state">Нет операций.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Тип</th>
                <th>Категория</th>
                <th>Товар</th>
                <th>Сумма</th>
                <th>Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.date)}</td>
                  <td>{TYPE_LABEL[r.type]}</td>
                  <td>{translateCategory(r.category)}</td>
                  <td>{r.product?.name ?? '—'}</td>
                  <td>{Math.round(r.amount).toLocaleString('ru-RU')} ₽</td>
                  <td style={{ color: 'var(--text-muted)' }}>{r.description ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
