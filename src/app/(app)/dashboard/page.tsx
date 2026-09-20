import { redirect } from 'next/navigation';
import { requireUser, listAccessibleProjects, assertProjectAccess, ForbiddenError } from '@/lib/authz';
import { resolvePeriod, formatDate } from '@/lib/period';
import { computeFinanceSummary, computeAttention, type CategoryBreakdown } from '@/lib/finance';
import { getProjectDataFreshness } from '@/lib/freshness';
import { FilterBar } from '@/components/FilterBar';
import { FreshnessBanner } from '@/components/FreshnessBanner';

export const dynamic = 'force-dynamic';

function money(n: number) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

function CategoryTable({ rows }: { rows: CategoryBreakdown }) {
  if (rows.length === 0) {
    return <div className="chain-detail" style={{ color: 'var(--text-muted)' }}>Нет операций за период</div>;
  }
  return (
    <div className="chain-detail">
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.category}>
              <td>{r.category}</td>
              <td>{Math.round(r.amount).toLocaleString('ru-RU')} ₽</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function DashboardPage({
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
    if (e instanceof ForbiddenError) redirect('/dashboard');
    throw e;
  }

  const storeId = searchParams.storeId || undefined;
  const { from, to } = resolvePeriod(searchParams);

  const [summary, attention, freshness] = await Promise.all([
    computeFinanceSummary({ projectId, storeId, from, to }),
    computeAttention({ projectId, storeId, from, to }),
    getProjectDataFreshness(projectId, storeId),
  ]);

  return (
    <div>
      <FilterBar basePath="/dashboard" projects={projects} selectedProjectId={projectId} selectedStoreId={storeId} from={from} to={to} />

      <FreshnessBanner dataAsOf={freshness.dataAsOf} isStale={freshness.isStale} />

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Выручка</div>
          <div className="kpi-value">{money(summary.revenue)}</div>
          <div className="kpi-sub">
            {formatDate(from)} – {formatDate(to)}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">
            <span
              className="tooltip-hint"
              title="Сумма всех расходов магазина за период по всем категориям: комиссии и сборы Ozon (комиссия, логистика, реклама, эквайринг и т.п.) + себестоимость проданных товаров + внешние расходы (если вносили вручную) + налог (по ставке проекта от выручки, если задана, плюс ручные налоговые операции)."
            >
              Все расходы
            </span>
          </div>
          <div className="kpi-value">{money(summary.totalExpenses)}</div>
          <div className="kpi-sub">комиссии Ozon + себестоимость + внешние + налоги</div>
        </div>
        <div className={`kpi-card ${summary.profit >= 0 ? 'positive' : 'negative'}`}>
          <div className="kpi-label">
            <span
              className="tooltip-hint"
              title="Выручка за период минус «Все расходы» (Ozon + себестоимость + внешние расходы + налог). Это итоговая прибыль магазина за период, уже после вычета налога."
            >
              Прибыль после налога
            </span>
          </div>
          <div className="kpi-value">{money(summary.profit)}</div>
          <div className="kpi-sub">осталось после всех расходов</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">
            <span
              className="tooltip-hint"
              title="Прибыль после налога за период, делённая на выручку за период (в процентах) — показывает, сколько из каждого рубля выручки остаётся прибылью после всех расходов."
            >
              Маржинальность
            </span>
          </div>
          <div className="kpi-value">{(summary.margin * 100).toFixed(1)}%</div>
          <div className="kpi-sub tooltip-hint" title="Прибыль, делённая на выручку">
            прибыль / выручка
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Из чего складывается результат</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -8, marginBottom: 14 }}>
          Нажмите на любой шаг, чтобы увидеть его состав
        </p>
        <div className="chain">
          <details className="chain-step">
            <summary>
              <div className="chain-label">Выручка</div>
              <div className="chain-value">{money(summary.revenue)}</div>
            </summary>
            <CategoryTable rows={summary.byType.REVENUE} />
          </details>
          <span className="chain-arrow">→</span>
          <details className="chain-step">
            <summary>
              <div className="chain-label">Расходы Ozon</div>
              <div className="chain-value">−{money(summary.ozonFees)}</div>
            </summary>
            <CategoryTable rows={summary.byType.OZON_FEE} />
          </details>
          <span className="chain-arrow">→</span>
          <details className="chain-step">
            <summary>
              <div className="chain-label">Себестоимость</div>
              <div className="chain-value">−{money(summary.cogs)}</div>
            </summary>
            <CategoryTable rows={summary.byType.COGS} />
          </details>
          <span className="chain-arrow">→</span>
          <details className="chain-step">
            <summary>
              <div className="chain-label">Внешние расходы</div>
              <div className="chain-value">−{money(summary.externalExpenses)}</div>
            </summary>
            <CategoryTable rows={summary.byType.EXTERNAL_EXPENSE} />
          </details>
          <span className="chain-arrow">→</span>
          <details className="chain-step">
            <summary>
              <div className="chain-label">Налоги</div>
              <div className="chain-value">−{money(summary.taxes)}</div>
            </summary>
            <CategoryTable rows={summary.byType.TAX} />
          </details>
          <span className="chain-arrow">=</span>
          <div className="chain-step" style={{ background: 'var(--primary-bg)', borderColor: '#cfe0fd' }}>
            <div className="chain-label">Прибыль</div>
            <div className="chain-value">{money(summary.profit)}</div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Требует внимания</h2>
        {attention.length === 0 ? (
          <div className="empty-state">Явных проблем за период не найдено.</div>
        ) : (
          <div className="attention-list">
            {attention.map((a, i) => (
              <div key={i} className={`attention-item ${a.severity}`}>
                <span className="attention-badge">{a.severity === 'critical' ? 'Важно' : 'Проверить'}</span>
                <div>
                  <div className="attention-title">
                    {a.title}
                    {a.href && (
                      <>
                        {' '}
                        · <a href={a.href}>Подробнее</a>
                      </>
                    )}
                  </div>
                  <div className="attention-detail">{a.detail}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
