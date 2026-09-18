import { requireUser, listAccessibleProjects, assertProjectAccess } from '@/lib/authz';
import { resolvePeriod, formatDate } from '@/lib/period';
import { computeProductInsights } from '@/lib/finance';
import { prisma } from '@/lib/prisma';
import { FilterBar } from '@/components/FilterBar';

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  OZON_FEE: 'Расходы Ozon',
  COGS: 'Себестоимость',
  EXTERNAL_EXPENSE: 'Внешние расходы',
  TAX: 'Налоги',
};

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

  const totalsByCategory = new Map<string, number>();
  for (const r of rows) {
    const key = `${TYPE_LABEL[r.type]} · ${r.category}`;
    totalsByCategory.set(key, (totalsByCategory.get(key) ?? 0) + r.amount);
  }

  // Себестоимость проданных товаров за период, по каждому товару — считается «живьём» от кол-ва
  // проданных штук × текущей себестоимости (та же логика, что и на странице «Товары»), а не
  // берётся из сохранённых COGS-строк выше — так сумма не занижается, если себестоимость ввели
  // уже после последней синхронизации (см. комментарий в lib/finance.ts computeProductInsights).
  const productInsights = await computeProductInsights({ projectId, storeId, from, to, dateBasis: 'order' });
  const soldProducts = productInsights
    .filter((p) => p.quantitySold > 0)
    .sort((a, b) => b.cogsFromTx - a.cogsFromTx);
  const totalCogs = soldProducts.reduce((s, p) => s + p.cogsFromTx, 0);
  const totalQuantitySold = soldProducts.reduce((s, p) => s + p.quantitySold, 0);
  const missingCostCount = soldProducts.filter((p) => p.costPrice <= 0).length;

  return (
    <div>
      <FilterBar basePath="/expenses" projects={projects} selectedProjectId={projectId} selectedStoreId={storeId} from={from} to={to} />

      <div className="panel">
        <h2>Расходы по категориям</h2>
        {totalsByCategory.size === 0 ? (
          <div className="empty-state">За период расходов нет.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Категория</th>
                <th>Сумма</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(totalsByCategory.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([cat, amt]) => (
                  <tr key={cat}>
                    <td>{cat}</td>
                    <td>{Math.round(amt).toLocaleString('ru-RU')} ₽</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Товары: себестоимость проданного за период</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: -8, marginBottom: 14 }}>
          Себестоимость проданного = кол-во проданных штук товара за период × его себестоимость. Например,
          13 продаж по 699 ₽ себестоимости = 13 × 699 ₽ = 9 087 ₽. Сумма по каждому товару ниже, и общий итог
          — под таблицей. Показаны только товары с продажами за период; полный список товаров (включая без
          продаж) и подробности по каждому — на странице «Товары».
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
                  <td>{r.category}</td>
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
