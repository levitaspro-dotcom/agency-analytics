import { requireUser, listAccessibleProjects, assertProjectAccess, isManagerOrAbove } from '@/lib/authz';
import { resolvePeriod } from '@/lib/period';
import { computeProductInsights, dateWhere, type DateBasis } from '@/lib/finance';
import { prisma } from '@/lib/prisma';
import { FilterBar } from '@/components/FilterBar';
import { updateProductCostAction } from '../projects/page';

export const dynamic = 'force-dynamic';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: {
    projectId?: string;
    storeId?: string;
    from?: string;
    to?: string;
    q?: string;
    status?: string;
    sort?: string;
    dateBasis?: string;
  };
}) {
  const user = await requireUser();
  const projects = await listAccessibleProjects(user);
  if (projects.length === 0) return <div className="empty-state">Нет доступных магазинов.</div>;

  const projectId = searchParams.projectId && projects.some((p) => p.id === searchParams.projectId) ? searchParams.projectId : projects[0].id;
  await assertProjectAccess(user, projectId);
  const storeId = searchParams.storeId || undefined;
  const { from, to } = resolvePeriod(searchParams);
  const canEdit = isManagerOrAbove(user.role);
  const dateBasis: DateBasis = searchParams.dateBasis === 'accrual' ? 'accrual' : 'order';

  const SORT_VALUES = ['true_margin_asc', 'true_margin_desc'] as const;
  const q = (searchParams.q || '').trim();
  const status = searchParams.status === 'selling' || searchParams.status === 'not_selling' ? searchParams.status : '';
  const sort = (SORT_VALUES as readonly string[]).includes(searchParams.sort || '') ? (searchParams.sort as (typeof SORT_VALUES)[number]) : '';

  const allProducts = await computeProductInsights({ projectId, storeId, from, to, dateBasis });

  // Диагностика для менеджеров: операции за период, которые не удалось привязать ни к одному
  // товару (сумма нигде не пропадает — она всё ещё учтена в «Расходах»/«Обзоре», но не видна на
  // этой странице ни у одного товара). externalId кодирует SKU/артикул, по которому Ozon отдал
  // эту строку — по нему можно на глаз понять, какой именно идентификатор не совпал с товаром.
  const unmatchedTx = canEdit
    ? await prisma.financeTransaction.findMany({
        where: {
          projectId,
          ...(storeId ? { storeId } : {}),
          productId: null,
          type: { in: ['REVENUE', 'OZON_FEE'] },
          ...dateWhere(dateBasis, from, to),
        },
        orderBy: { amount: 'desc' },
        take: 30,
        select: { id: true, type: true, category: true, amount: true, quantity: true, date: true, externalId: true },
      })
    : [];

  const productRows = await prisma.product.findMany({
    where: { projectId, active: true, ...(storeId ? { storeId } : {}) },
    select: { id: true, sellPrice: true, costPrice: true },
  });
  const sellPriceById = new Map<string, { sellPrice: number; costPrice: number }>();
  for (const row of productRows) sellPriceById.set(row.id, { sellPrice: row.sellPrice, costPrice: row.costPrice });

  // Поиск по названию/SKU, фильтр по статусу продаж и сортировка по марже — применяются к уже
  // посчитанным показателям, категории товара Ozon не отдаёт (это отдельная задача на будущее).
  let products = allProducts;
  if (q) {
    const needle = q.toLowerCase();
    products = products.filter((p) => p.name.toLowerCase().includes(needle) || p.sku.toLowerCase().includes(needle));
  }
  if (status === 'selling') products = products.filter((p) => p.quantitySold > 0);
  if (status === 'not_selling') products = products.filter((p) => p.quantitySold === 0);
  if (sort === 'true_margin_asc' || sort === 'true_margin_desc') {
    const dir = sort === 'true_margin_asc' ? 1 : -1;
    products = [...products].sort((a, b) => {
      if (a.periodMargin === null && b.periodMargin === null) return 0;
      if (a.periodMargin === null) return 1;
      if (b.periodMargin === null) return -1;
      return (a.periodMargin - b.periodMargin) * dir;
    });
  }
  const filtersActive = q !== '' || status !== '' || sort !== '';

  // Итоговая строка под таблицей — суммы по товарам, которые сейчас видны в таблице (с учётом
  // фильтров). «Себестоимость проданного, итого» — это и есть общая сумма по себестоимости
  // проданных товаров за период (кол-во проданных штук каждого товара × его себестоимость,
  // просуммированное по всем товарам).
  const totals = products.reduce(
    (acc, p) => {
      acc.quantitySold += p.quantitySold;
      acc.revenue += p.revenue;
      acc.cogsFromTx += p.cogsFromTx;
      acc.commissionFee += p.commissionFee;
      acc.logisticsFee += p.logisticsFee;
      acc.handlingFee += p.handlingFee;
      acc.otherFee += p.otherFee;
      acc.taxAmount += p.taxAmount;
      acc.totalExpenses += p.totalExpenses;
      acc.periodProfit += p.periodProfit;
      return acc;
    },
    {
      quantitySold: 0,
      revenue: 0,
      cogsFromTx: 0,
      commissionFee: 0,
      logisticsFee: 0,
      handlingFee: 0,
      otherFee: 0,
      taxAmount: 0,
      totalExpenses: 0,
      periodProfit: 0,
    },
  );
  const totalMargin = totals.revenue > 0 ? totals.periodProfit / totals.revenue : null;

  return (
    <div>
      <FilterBar basePath="/products" projects={projects} selectedProjectId={projectId} selectedStoreId={storeId} from={from} to={to} dateBasis={dateBasis} />
      <div className="panel">
        <h2>Товары за период</h2>
        {allProducts.length === 0 ? (
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
              товару. Реклама (оплата за клик), эквайринг, доставка до места выдачи и подобные сборы теперь
              тоже подтягиваются при синхронизации, но Ozon в принципе не привязывает их к конкретному товару
              (это не позаказные, а периодические расходы) — их сумма учтена в «Все расходы» на уровне всего
              магазина, в «Расходах» и «Обзоре», но не в разбивке по товарам ниже (см. «Без привязки к товару»
              под таблицей). Хранение Ozon пока отдаёт только через отдельный отчёт — эта категория ещё не
              подключена. Строки с убытком за период подсвечены.
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: -8, marginBottom: 14 }}>
              <b>Маржинальность</b> — это прибыль / выручка по товару за период, ПОСЛЕ вычета себестоимости,
              всех сборов Ozon И налога по этому товару (наведите на заголовки столбцов «Итого расходов»,
              «Прибыль за период» и «Маржинальность» — там расписано, что именно входит в каждый).
            </p>
            {dateBasis === 'accrual' && (
              <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: -8, marginBottom: 14 }}>
                Период сейчас считается «по дате начисления Ozon» (переключатель «Период по дате» вверху) — так
                же, как в официальных отчётах Ozon (например, «Отчёт по начислениям»). Показаны только уже
                начисленные площадкой отправления: если заказ оформлен, но Ozon ещё не провёл по нему начисление,
                строка появится здесь только после того, как начисление произойдёт и магазин пересинхронизируется
                — поэтому количество тут обычно меньше, чем в режиме «по дате заказа», особенно для последних
                дней периода.
              </p>
            )}
            <form method="get" action="/products" className="topbar" style={{ marginBottom: 16, paddingBottom: 16 }}>
              <input type="hidden" name="projectId" value={projectId} />
              {storeId && <input type="hidden" name="storeId" value={storeId} />}
              <input type="hidden" name="from" value={searchParams.from ?? ''} />
              <input type="hidden" name="to" value={searchParams.to ?? ''} />
              <input type="hidden" name="dateBasis" value={dateBasis} />
              <div className="field">
                <label>Название или SKU</label>
                <input type="text" name="q" defaultValue={q} placeholder="например, Кисель или 5342414889" style={{ minWidth: 220 }} />
              </div>
              <div className="field">
                <label>Продажи</label>
                <select name="status" defaultValue={status}>
                  <option value="">Все</option>
                  <option value="selling">Продаётся</option>
                  <option value="not_selling">Нет продаж за период</option>
                </select>
              </div>
              <div className="field">
                <label>Сортировка</label>
                <select name="sort" defaultValue={sort}>
                  <option value="">По умолчанию</option>
                  <option value="true_margin_desc">Маржинальность: сначала высокая</option>
                  <option value="true_margin_asc">Маржинальность: сначала низкая</option>
                </select>
              </div>
              <button className="btn btn-primary" type="submit">
                Применить
              </button>
              {filtersActive && (
                <a
                  className="btn"
                  href={`/products?projectId=${projectId}${storeId ? `&storeId=${storeId}` : ''}&from=${searchParams.from ?? ''}&to=${searchParams.to ?? ''}&dateBasis=${dateBasis}`}
                >
                  Сбросить
                </a>
              )}
            </form>
            {filtersActive && (
              <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: -8, marginBottom: 14 }}>
                Найдено {products.length} из {allProducts.length}.
              </p>
            )}
            {products.length === 0 ? (
              <div className="empty-state">Ничего не найдено по этому фильтру.</div>
            ) : (
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
                    <th
                      className="tooltip-hint"
                      title="Кол-во, шт × Себестоимость за период — общая сумма себестоимости проданных штук этого товара (например, 13 продаж × 699 ₽ = 9 087 ₽)"
                    >
                      Себестоимость проданного
                    </th>
                    <th>Выручка</th>
                    <th>Комиссия Ozon</th>
                    <th>Логистика</th>
                    <th>Обработка отправления</th>
                    <th>Прочие сборы Ozon</th>
                    <th
                      className="tooltip-hint"
                      title="Ставка налога задаётся в настройках проекта. Налог по товару = выручка по этому товару за период × ставка налога. 0 ₽, если ставка не задана."
                    >
                      Налог
                    </th>
                    <th
                      className="tooltip-hint"
                      title="Себестоимость проданного (кол-во шт × себестоимость) + сборы Ozon по этому товару за период (Комиссия + Логистика + Обработка отправления + Прочие сборы) + налог по товару. Внешние расходы сюда не входят — они не привязаны к конкретному товару, их итог смотрите в «Все расходы» на «Обзоре»/«Отчётах»."
                    >
                      Итого расходов
                    </th>
                    <th
                      className="tooltip-hint"
                      title="Выручка по товару за период минус «Итого расходов» по нему (себестоимость проданного + все сборы Ozon + налог по товару)."
                    >
                      Прибыль за период
                    </th>
                    <th
                      className="tooltip-hint"
                      title="Прибыль / выручка за период, ПОСЛЕ вычета себестоимости, всех сборов Ozon И налога по товару — настоящая маржинальность. «—», если за период не было выручки"
                    >
                      Маржинальность
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
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {p.quantitySold > 0 && priced && priced.costPrice > 0
                            ? `${p.quantitySold} × ${Math.round(priced.costPrice).toLocaleString('ru-RU')} ₽ = ${Math.round(p.cogsFromTx).toLocaleString('ru-RU')} ₽`
                            : '—'}
                        </td>
                        <td>{Math.round(p.revenue).toLocaleString('ru-RU')} ₽</td>
                        <td>{Math.round(p.commissionFee).toLocaleString('ru-RU')} ₽</td>
                        <td>{Math.round(p.logisticsFee).toLocaleString('ru-RU')} ₽</td>
                        <td>{Math.round(p.handlingFee).toLocaleString('ru-RU')} ₽</td>
                        <td>{Math.round(p.otherFee).toLocaleString('ru-RU')} ₽</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {p.taxAmount > 0
                            ? `${Math.round(p.taxAmount).toLocaleString('ru-RU')} ₽ (${p.taxRatePercent}%)`
                            : p.taxRatePercent > 0
                              ? '0 ₽'
                              : '—'}
                        </td>
                        <td>{Math.round(p.totalExpenses).toLocaleString('ru-RU')} ₽</td>
                        <td style={{ color: p.periodProfit < 0 ? 'var(--bad)' : 'inherit', fontWeight: isLoss ? 600 : 400 }}>
                          {Math.round(p.periodProfit).toLocaleString('ru-RU')} ₽
                        </td>
                        <td style={{ color: p.periodMargin !== null && p.periodMargin < 0 ? 'var(--bad)' : 'inherit', fontWeight: 600 }}>
                          {p.periodMargin === null ? '—' : (p.periodMargin * 100).toFixed(1) + '%'}
                        </td>
                        <td>
                          {p.flag ? (
                            <span className={`pill ${p.flag}`} title={p.reason}>
                              {p.flag === 'critical' ? 'Убыточен' : p.unitMargin === null ? 'Нет себестоимости' : 'Низкая наценка'}
                            </span>
                          ) : (
                            <span className="pill ok">Норма</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 600, borderTop: '2px solid var(--border)' }}>
                    <td>Итого{filtersActive ? ` (по ${products.length} товарам с учётом фильтра)` : ''}</td>
                    <td></td>
                    <td></td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{totals.quantitySold || '—'}</td>
                    <td></td>
                    <td></td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(totals.cogsFromTx).toLocaleString('ru-RU')} ₽</td>
                    <td>{Math.round(totals.revenue).toLocaleString('ru-RU')} ₽</td>
                    <td>{Math.round(totals.commissionFee).toLocaleString('ru-RU')} ₽</td>
                    <td>{Math.round(totals.logisticsFee).toLocaleString('ru-RU')} ₽</td>
                    <td>{Math.round(totals.handlingFee).toLocaleString('ru-RU')} ₽</td>
                    <td>{Math.round(totals.otherFee).toLocaleString('ru-RU')} ₽</td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(totals.taxAmount).toLocaleString('ru-RU')} ₽</td>
                    <td>{Math.round(totals.totalExpenses).toLocaleString('ru-RU')} ₽</td>
                    <td style={{ color: totals.periodProfit < 0 ? 'var(--bad)' : 'inherit' }}>
                      {Math.round(totals.periodProfit).toLocaleString('ru-RU')} ₽
                    </td>
                    <td style={{ color: totalMargin !== null && totalMargin < 0 ? 'var(--bad)' : 'inherit' }}>
                      {totalMargin === null ? '—' : (totalMargin * 100).toFixed(1) + '%'}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            )}
            {canEdit && unmatchedTx.length > 0 && (
              <details style={{ marginTop: 20 }}>
                <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-muted)' }}>
                  Без привязки к товару за период: {unmatchedTx.length} (сумма не потеряна — учтена в «Расходах»/«Обзоре», но не видна выше ни у одного товара)
                </summary>
                <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: '10px 0' }}>
                  Две разные причины здесь смешаны. Часть строк — это реклама, эквайринг, доставка до места
                  выдачи и подобные периодические сборы: они не привязаны к товару НАМЕРЕННО, Ozon сам не
                  относит их к конкретному SKU (в «Ключе» ниже такие строки начинаются с «nonitem:»). Остальное —
                  обычные позаказные операции, у которых Ozon не прислал SKU/артикул, совпадающий с текущим
                  товаром (например, если SKU сменился после переиздания карточки); «Ключ» показывает, что
                  фактически пришло от Ozon, чтобы было видно, какой именно идентификатор не совпал.
                </p>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Тип</th>
                      <th>Категория</th>
                      <th>Сумма</th>
                      <th>Кол-во</th>
                      <th>Дата</th>
                      <th>Ключ (externalId)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unmatchedTx.map((t) => (
                      <tr key={t.id}>
                        <td>{t.type === 'REVENUE' ? 'Выручка' : 'Комиссия/сбор'}</td>
                        <td>{t.category}</td>
                        <td>{Math.round(t.amount).toLocaleString('ru-RU')} ₽</td>
                        <td>{t.quantity ?? '—'}</td>
                        <td>{t.date.toISOString().slice(0, 10)}</td>
                        <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-muted)' }}>{t.externalId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
