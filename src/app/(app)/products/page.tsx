import { requireUser, listAccessibleProjects, assertProjectAccess, isManagerOrAbove } from '@/lib/authz';
import { resolvePeriod } from '@/lib/period';
import { computeProductInsights } from '@/lib/finance';
import { prisma } from '@/lib/prisma';
import { FilterBar } from '@/components/FilterBar';
import { updateProductCostAction } from '../projects/page';

export const dynamic = 'force-dynamic';

export default async function ProductsPage({
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
  const canEdit = isManagerOrAbove(user.role);

  const products = await computeProductInsights({ projectId, storeId, from, to });
  const productRows = await prisma.product.findMany({
    where: { projectId, active: true, ...(storeId ? { storeId } : {}) },
    select: { id: true, sellPrice: true, costPrice: true },
  });
  const sellPriceById = new Map<string, { sellPrice: number; costPrice: number }>();
  for (const row of productRows) sellPriceById.set(row.id, { sellPrice: row.sellPrice, costPrice: row.costPrice });

  return (
    <div>
      <FilterBar basePath="/products" projects={projects} selectedProjectId={projectId} selectedStoreId={storeId} from={from} to={to} />
      <div className="panel">
        <h2>Товары за период</h2>
        {products.length === 0 ? (
          <div className="empty-state">
            В этом магазине пока нет товаров. Они появятся здесь автоматически после синхронизации
            (раздел «Магазины» → «Синхронизировать»).
          </div>
        ) : (
          <>
            {canEdit && (
              <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: -8, marginBottom: 14 }}>
                Цену продажи и название Ozon обновляет сам при каждой синхронизации. Себестоимость Ozon не
                передаёт — её нужно ввести один раз для каждого товара, иначе маржу с единицы честно посчитать
                нельзя.
              </p>
            )}
            <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: -8, marginBottom: 14 }}>
              Комиссия, логистика и обработка отправления — по данным Ozon за период, отдельно по каждому
              товару. Рекламу и хранение Ozon отдаёт через другие отчёты — это отдельная задача, пока их здесь
              нет. Строки с убытком за период подсвечены.
            </p>
            <div className="table-scroll sticky-head" style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Товар</th>
                    <th>SKU</th>
                    <th>Продажи</th>
                    <th>Кол-во, шт</th>
                    <th>Цена продажи</th>
                    <th>Себестоимость</th>
                    <th>Выручка</th>
                    <th>Комиссия Ozon</th>
                    <th>Логистика</th>
                    <th>Обработка отправления</th>
                    <th>Прочие сборы Ozon</th>
                    <th>Итого расходов</th>
                    <th>Прибыль за период</th>
                    <th className="tooltip-hint" title="(цена продажи − себестоимость) / цена продажи">
                      Маржа с единицы
                    </th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => {
                    const priced = sellPriceById.get(p.id);
                    const isLoss = p.flag === 'critical';
                    return (
                      <tr key={p.id} style={isLoss ? { background: 'var(--bad-bg)' } : undefined}>
                        <td>{p.name}</td>
                        <td style={{ color: 'var(--text-muted)' }}>{p.sku}</td>
                        <td>
                          {p.quantitySold > 0 ? (
                            <span className="pill ok">Продаётся</span>
                          ) : (
                            <span className="pill" style={{ background: 'var(--border)', color: 'var(--text-muted)' }}>
                              Нет продаж за период
                            </span>
                          )}
                        </td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.quantitySold || '—'}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {priced ? Math.round(priced.sellPrice).toLocaleString('ru-RU') + ' ₽' : '—'}
                        </td>
                        <td>
                          {canEdit ? (
                            <form action={updateProductCostAction} style={{ display: 'flex', gap: 4 }}>
                              <input type="hidden" name="productId" value={p.id} />
                              <input
                                type="text"
                                name="costPrice"
                                defaultValue={priced && priced.costPrice > 0 ? priced.costPrice : ''}
                                placeholder="ввести"
                                style={{ width: 76, padding: '4px 6px', fontSize: 12.5 }}
                              />
                              <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                                ✓
                              </button>
                            </form>
                          ) : priced && priced.costPrice > 0 ? (
                            Math.round(priced.costPrice).toLocaleString('ru-RU') + ' ₽'
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{Math.round(p.revenue).toLocaleString('ru-RU')} ₽</td>
                        <td>{Math.round(p.commissionFee).toLocaleString('ru-RU')} ₽</td>
                        <td>{Math.round(p.logisticsFee).toLocaleString('ru-RU')} ₽</td>
                        <td>{Math.round(p.handlingFee).toLocaleString('ru-RU')} ₽</td>
                        <td>{Math.round(p.otherFee).toLocaleString('ru-RU')} ₽</td>
                        <td>{Math.round(p.totalExpenses).toLocaleString('ru-RU')} ₽</td>
                        <td style={{ color: p.periodProfit < 0 ? 'var(--bad)' : 'inherit', fontWeight: isLoss ? 600 : 400 }}>
                          {Math.round(p.periodProfit).toLocaleString('ru-RU')} ₽
                        </td>
                        <td>{p.unitMargin === null ? '—' : (p.unitMargin * 100).toFixed(1) + '%'}</td>
                        <td>
                          {p.flag ? (
                            <span className={`pill ${p.flag}`} title={p.reason}>
                              {p.flag === 'critical' ? 'Убыточен' : p.unitMargin === null ? 'Нет себестоимости' : 'Низкая маржа'}
                            </span>
                          ) : (
                            <span className="pill ok">Норма</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
