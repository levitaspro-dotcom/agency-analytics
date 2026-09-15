import { requireUser, listAccessibleProjects, assertProjectAccess } from '@/lib/authz';
import { resolvePeriod } from '@/lib/period';
import { computeProductInsights } from '@/lib/finance';
import { FilterBar } from '@/components/FilterBar';

export const dynamic = 'force-dynamic';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: { projectId?: string; storeId?: string; from?: string; to?: string };
}) {
  const user = await requireUser();
  const projects = await listAccessibleProjects(user);
  if (projects.length === 0) return <div className="empty-state">Нет доступных проектов.</div>;

  const projectId = searchParams.projectId && projects.some((p) => p.id === searchParams.projectId) ? searchParams.projectId : projects[0].id;
  await assertProjectAccess(user, projectId);
  const storeId = searchParams.storeId || undefined;
  const { from, to } = resolvePeriod(searchParams);

  const products = await computeProductInsights({ projectId, storeId, from, to });

  return (
    <div>
      <FilterBar basePath="/products" projects={projects} selectedProjectId={projectId} selectedStoreId={storeId} from={from} to={to} />
      <div className="panel">
        <h2>Товары за период</h2>
        {products.length === 0 ? (
          <div className="empty-state">В проекте пока нет товаров.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Товар</th>
                <th>SKU</th>
                <th>Выручка</th>
                <th>Расходы на товар</th>
                <th>Прибыль за период</th>
                <th className="tooltip-hint" title="(цена продажи − себестоимость) / цена продажи">
                  Маржа с единицы
                </th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{p.sku}</td>
                  <td>{Math.round(p.revenue).toLocaleString('ru-RU')} ₽</td>
                  <td>{Math.round(p.cogsFromTx).toLocaleString('ru-RU')} ₽</td>
                  <td style={{ color: p.periodProfit < 0 ? 'var(--bad)' : 'inherit' }}>
                    {Math.round(p.periodProfit).toLocaleString('ru-RU')} ₽
                  </td>
                  <td>{(p.unitMargin * 100).toFixed(1)}%</td>
                  <td>
                    {p.flag ? (
                      <span className={`pill ${p.flag}`} title={p.reason}>
                        {p.flag === 'critical' ? 'Убыточен' : 'Низкая маржа'}
                      </span>
                    ) : (
                      <span className="pill ok">Норма</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
