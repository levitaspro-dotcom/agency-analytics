import { redirect } from 'next/navigation';
import { requireUser, listAccessibleProjects, assertProjectAccess, ForbiddenError } from '@/lib/authz';
import { resolvePeriod, formatDate, inputDate } from '@/lib/period';
import { computeFinanceSummary, computeProductInsights, type CategoryBreakdown } from '@/lib/finance';
import { getProjectDataFreshness } from '@/lib/freshness';
import { prisma } from '@/lib/prisma';
import { FilterBar } from '@/components/FilterBar';
import { FreshnessBanner } from '@/components/FreshnessBanner';

export const dynamic = 'force-dynamic';

function money(n: number) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

function PlainCategoryTable({ rows }: { rows: CategoryBreakdown }) {
  if (rows.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Нет операций за период</div>;
  }
  return (
    <table className="data-table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.category}>
            <td>{r.category}</td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(r.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: { projectId?: string; storeId?: string; from?: string; to?: string };
}) {
  const user = await requireUser();
  const projects = await listAccessibleProjects(user);

  if (projects.length === 0) {
    return <div className="empty-state">У вас пока нет доступных магазинов. Обратитесь к администратору.</div>;
  }

  const projectId = searchParams.projectId && projects.some((p) => p.id === searchParams.projectId) ? searchParams.projectId : projects[0].id;

  try {
    await assertProjectAccess(user, projectId);
  } catch (e) {
    if (e instanceof ForbiddenError) redirect('/reports');
    throw e;
  }

  const storeId = searchParams.storeId || undefined;
  const { from, to } = resolvePeriod(searchParams);
  const project = projects.find((p) => p.id === projectId)!;
  const storeName = storeId ? project.stores.find((s) => s.id === storeId)?.name : undefined;

  const [summary, products, freshness, recommendations] = await Promise.all([
    computeFinanceSummary({ projectId, storeId, from, to }),
    computeProductInsights({ projectId, storeId, from, to }),
    getProjectDataFreshness(projectId, storeId),
    prisma.aiRecommendation.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 5 }),
  ]);

  const flaggedProducts = products.filter((p) => p.flag);
  const exportHref = `/reports/export?projectId=${projectId}${storeId ? `&storeId=${storeId}` : ''}&from=${inputDate(from)}&to=${inputDate(to)}`;

  return (
    <div>
      <div className="no-print">
        <FilterBar basePath="/reports" projects={projects} selectedProjectId={projectId} selectedStoreId={storeId} from={from} to={to} />
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
          <a className="btn btn-primary" href={exportHref}>
            Скачать CSV (все операции за период)
          </a>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Для PDF — печать страницы (Cmd/Ctrl+P): фильтры и меню в печать не попадут.
          </span>
        </div>
      </div>

      <FreshnessBanner dataAsOf={freshness.dataAsOf} isStale={freshness.isStale} />

      <div className="panel">
        <h2>
          Отчёт: {project.client.name} · {project.name}
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -8, marginBottom: 14 }}>
          Период: {formatDate(from)} – {formatDate(to)}
          {storeName ? ` · подключение: ${storeName}` : ''}
        </p>

        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">Выручка</div>
            <div className="kpi-value">{money(summary.revenue)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Все расходы</div>
            <div className="kpi-value">{money(summary.totalExpenses)}</div>
            <div className="kpi-sub">комиссии Ozon + себестоимость + внешние + налоги</div>
          </div>
          <div className={`kpi-card ${summary.profit >= 0 ? 'positive' : 'negative'}`}>
            <div className="kpi-label">Прибыль после налога</div>
            <div className="kpi-value">{money(summary.profit)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Маржинальность</div>
            <div className="kpi-value">{(summary.margin * 100).toFixed(1)}%</div>
          </div>
        </div>

        <h3>Комиссии Ozon</h3>
        <PlainCategoryTable rows={summary.byType.OZON_FEE} />
        <h3>Себестоимость</h3>
        <PlainCategoryTable rows={summary.byType.COGS} />
        <h3>Внешние расходы</h3>
        <PlainCategoryTable rows={summary.byType.EXTERNAL_EXPENSE} />
        <h3>Налоги</h3>
        <PlainCategoryTable rows={summary.byType.TAX} />
      </div>

      {flaggedProducts.length > 0 && (
        <div className="panel">
          <h2>Товары, требующие внимания</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Товар</th>
                <th>SKU</th>
                <th>Прибыль за период</th>
                <th>Причина</th>
              </tr>
            </thead>
            <tbody>
              {flaggedProducts.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.sku}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.periodProfit)}</td>
                  <td>{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {recommendations.length > 0 && (
        <div className="panel">
          <h2>Рекомендации ИИ-аналитика (последние)</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: -8, marginBottom: 14 }}>
            Полная история с обоснованием — в разделе «ИИ-аналитик».
          </p>
          {recommendations.map((r) => (
            <div key={r.id} className="rec-card">
              <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13.5 }}>{r.problem}</div>
              <div className="rec-row">
                <b>Действие:</b> {r.action}
              </div>
              <div className="rec-row" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                Данные на {r.dataAsOf.toLocaleString('ru-RU')} · сформировано {r.createdAt.toLocaleString('ru-RU')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
