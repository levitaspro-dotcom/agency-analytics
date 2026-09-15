import { requireUser, listAccessibleProjects, assertProjectAccess } from '@/lib/authz';
import { resolvePeriod, formatDate } from '@/lib/period';
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
  if (projects.length === 0) return <div className="empty-state">Нет доступных проектов.</div>;

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
