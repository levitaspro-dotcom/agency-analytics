import { redirect } from 'next/navigation';
import { requireUser, listAccessibleProjects } from '@/lib/authz';
import { resolvePeriod, formatDate, inputDate } from '@/lib/period';
import { computeFinanceSummary, computeAttention } from '@/lib/finance';
import { getProjectDataFreshness } from '@/lib/freshness';

export const dynamic = 'force-dynamic';

function money(n: number) {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽';
}

export default async function AgencyOverviewPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}) {
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') redirect('/dashboard');

  const { from, to } = resolvePeriod(searchParams);
  const projects = await listAccessibleProjects(user); // SUPER_ADMIN видит все проекты агентства

  const rows = await Promise.all(
    projects.map(async (p) => {
      const [summary, attention, freshness] = await Promise.all([
        computeFinanceSummary({ projectId: p.id, from, to }),
        computeAttention({ projectId: p.id, from, to }),
        getProjectDataFreshness(p.id),
      ]);
      return { project: p, summary, attentionCount: attention.length, freshness };
    }),
  );

  rows.sort((a, b) => a.summary.profit - b.summary.profit); // проблемные проекты — сверху

  const totals = rows.reduce(
    (acc, r) => ({
      revenue: acc.revenue + r.summary.revenue,
      totalExpenses: acc.totalExpenses + r.summary.totalExpenses,
      profit: acc.profit + r.summary.profit,
    }),
    { revenue: 0, totalExpenses: 0, profit: 0 },
  );
  const totalMargin = totals.revenue > 0 ? totals.profit / totals.revenue : 0;
  const staleCount = rows.filter((r) => r.freshness.isStale).length;
  const lossCount = rows.filter((r) => r.summary.profit < 0).length;

  return (
    <div>
      <form method="get" action="/agency" className="topbar">
        <div className="field">
          <label>Период с</label>
          <input type="date" name="from" defaultValue={inputDate(from)} />
        </div>
        <div className="field">
          <label>по</label>
          <input type="date" name="to" defaultValue={inputDate(to)} />
        </div>
        <button className="btn btn-primary" type="submit">
          Показать
        </button>
      </form>

      <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -14, marginBottom: 20 }}>
        Сводка по всем продавцам и проектам агентства за {formatDate(from)} – {formatDate(to)}. Как главный
        администратор вы видите здесь все текущие и будущие проекты автоматически — без ручного назначения.
      </p>

      {projects.length === 0 ? (
        <div className="empty-state">Проектов пока нет — создайте первый в разделе «Проекты».</div>
      ) : (
        <>
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label">Выручка по агентству</div>
              <div className="kpi-value">{money(totals.revenue)}</div>
              <div className="kpi-sub">{rows.length} проектов за период</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Все расходы</div>
              <div className="kpi-value">{money(totals.totalExpenses)}</div>
            </div>
            <div className={`kpi-card ${totals.profit >= 0 ? 'positive' : 'negative'}`}>
              <div className="kpi-label">Суммарная прибыль</div>
              <div className="kpi-value">{money(totals.profit)}</div>
              <div className="kpi-sub">маржа {(totalMargin * 100).toFixed(1)}%</div>
            </div>
            <div className={`kpi-card ${lossCount > 0 || staleCount > 0 ? 'negative' : 'positive'}`}>
              <div className="kpi-label">Требуют внимания</div>
              <div className="kpi-value">{lossCount}</div>
              <div className="kpi-sub">
                проектов в убытке{staleCount > 0 ? ` · ${staleCount} с устаревшими данными` : ''}
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>Проекты</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: -8, marginBottom: 14 }}>
              Сначала — проекты с наименьшей прибылью за период.
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Продавец</th>
                  <th>Проект</th>
                  <th>Выручка</th>
                  <th>Расходы</th>
                  <th>Прибыль</th>
                  <th>Маржа</th>
                  <th>Внимание</th>
                  <th>Данные</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ project, summary, attentionCount, freshness }) => (
                  <tr key={project.id}>
                    <td>{project.client.name}</td>
                    <td>{project.name}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(summary.revenue)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(summary.totalExpenses)}</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', color: summary.profit < 0 ? 'var(--bad)' : undefined }}>
                      {money(summary.profit)}
                    </td>
                    <td>{(summary.margin * 100).toFixed(1)}%</td>
                    <td>
                      {attentionCount > 0 ? <span className="pill warning">{attentionCount}</span> : <span className="pill ok">0</span>}
                    </td>
                    <td>
                      {freshness.isStale ? (
                        <span className="pill critical">устарели</span>
                      ) : (
                        <span className="pill ok">свежие</span>
                      )}
                    </td>
                    <td>
                      <a href={`/dashboard?projectId=${project.id}&from=${inputDate(from)}&to=${inputDate(to)}`}>Открыть</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
