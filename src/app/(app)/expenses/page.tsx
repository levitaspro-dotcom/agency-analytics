import { requireUser, listAccessibleProjects, assertProjectAccess } from '@/lib/authz';
import { resolvePeriod, formatDate } from '@/lib/period';
import { computeFinanceSummary, computeProductInsights, computeProductExpenseDetail, type CategoryBreakdown } from '@/lib/finance';
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

/** Рубли сверху, проценты снизу — в одной ячейке, как просила Ольга для ДРР и Прибыли. */
function stackedCell(top: string, bottom: string, color?: string) {
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div style={{ fontVariantNumeric: 'tabular-nums', color }}>{top}</div>
      <div style={{ fontSize: 11, color: color ?? 'var(--text-muted)' }}>{bottom}</div>
    </div>
  );
}

/** Убыток / требует внимания / хорошо — те же флаги, что уже посчитаны в computeProductInsights
 *  (flag/reason), просто с подписями и цветом под эту таблицу. Единая логика с «Товарами» —
 *  никакой отдельной, возможно расходящейся оценки «хорошо ли идут дела» здесь нет. */
function statusMeta(flag: 'critical' | 'warning' | null): { label: string; cls: 'critical' | 'warning' | 'ok'; bg: string } {
  if (flag === 'critical') return { label: 'Убыток', cls: 'critical', bg: 'var(--bad-bg)' };
  if (flag === 'warning') return { label: 'Внимание', cls: 'warning', bg: 'var(--warn-bg)' };
  return { label: 'Хорошо', cls: 'ok', bg: 'var(--good-bg)' };
}

function qtyCell(n: number | null) {
  return n === null ? '—' : n.toLocaleString('ru-RU');
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

  // Подробная постатейная таблица по каждому товару — все расходы Ozon в разбивке по конкретным
  // категориям (а не 4 укрупнённые группы, как на «Товарах»), плюс данные из «Позаказного отчёта о
  // реализации» (штрихкод, доставлено/возвращено, баллы/партнёрские программы) — см. комментарии в
  // lib/finance.ts (computeProductExpenseDetail) о том, почему часть столбцов может быть «—».
  const detailAll = await computeProductExpenseDetail({ projectId, storeId, from, to, dateBasis: 'order' });
  const detail = detailAll.filter((p) => p.quantitySold > 0 || p.revenue > 0 || p.totalExpenses > 0);
  const detailTotals = detail.reduce(
    (acc, p) => {
      acc.cogsFromTx += p.cogsFromTx;
      acc.quantitySold += p.quantitySold;
      acc.revenue += p.revenue;
      acc.adSpend += p.adSpend;
      acc.periodProfit += p.periodProfit;
      for (const k of Object.keys(p.fine) as (keyof typeof p.fine)[]) acc.fine[k] = (acc.fine[k] ?? 0) + p.fine[k];
      return acc;
    },
    { cogsFromTx: 0, quantitySold: 0, revenue: 0, adSpend: 0, periodProfit: 0, fine: {} as Record<string, number> },
  );
  const detailTotalMargin = detailTotals.revenue > 0 ? detailTotals.periodProfit / detailTotals.revenue : null;
  const detailTotalDrr = detailTotals.revenue > 0 ? detailTotals.adSpend / detailTotals.revenue : null;

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
        <h2>Товары: подробно по каждому расходу</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: -8, marginBottom: 10 }}>
          Полная постатейная разбивка по каждому товару — все категории сборов Ozon по отдельности (а не
          укрупнённо, как в «Расходах по группам» выше), плюс данные из «Позаказного отчёта о реализации»
          (штрихкод, доставлено/возвращено штук, баллы покупателя, партнёрские программы банков). Сумма всех
          столбцов группы «Комиссии и сборы Ozon» + «Реклама и продвижение» по товару равна его «Итого расходов»
          на странице «Товары» (себестоимость и налог показаны там же, здесь не повторяем). 0 ₽ в любом из этих
          столбцов означает «такого сбора по этому товару за период не было» — это реальный подсчёт, а не «не
          подключено». Строки подсвечены по статусу: убыток — красным, требует внимания — жёлтым, хорошо —
          зелёным (тот же критерий, что и столбец «Статус» на «Товарах»).
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: -4, marginBottom: 14 }}>
          <b>Штрихкод, Доставлено, Возвращено, Баллы за скидку и Партнёрские программы</b> Ozon отдаёт только
          отдельным отчётом за уже ЗАКРЫТЫЙ календарный месяц (публикует не раньше 5 числа следующего) — для
          текущего/недавнего периода там будет «—», это не потерянные данные, а нормальное состояние: цифры
          появятся сами после того, как месяц закроется и магазин пересинхронизируется (раздел «Магазины»).
          Если период короче месяца — эти пять столбцов всё равно показывают данные за ВЕСЬ календарный месяц
          (Ozon не отдаёт их мельче). <b>CTR</b> недоступен — нужна отдельная интеграция с рекламным API Ozon
          (Performance API), сейчас не подключена.
        </p>
        <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginTop: -4, marginBottom: 14 }}>
          <b>На коротких периодах (особенно за текущий, ещё не закрытый месяц) «Комиссия Ozon» и другие сборы
          могут выглядеть непропорционально большими относительно «Цены продажи»/«Выручки» этой же строки —
          вплоть до превышения.</b> Причина не в ошибке подсчёта и не в потере/задвоении денег: «Продано,
          шт»/«Выручка» считаются по дате ОФОРМЛЕНИЯ заказа, а сборы Ozon — по дате, когда Ozon фактически
          провёл начисление (обычно на несколько дней позже заказа). При малом числе продаж товара за короткий
          период сбор может относиться к заказу из соседних дней, в том числе ещё вне выбранного периода — а
          выручка по нему в текущий период ещё не попала. На более широком периоде (месяц и больше, особенно
          уже закрытый) это расхождение сглаживается и комиссия возвращается к ожидаемому проценту от выручки.
          Для оценки прибыльности конкретного товара доверяйте более широкому периоду, а не последним
          нескольким дням.
        </p>
        {detail.length === 0 ? (
          <div className="empty-state">За период нет ни продаж, ни расходов по товарам.</div>
        ) : (
          <div className="table-scroll sticky-head" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr className="group-head-row">
                  <th colSpan={3}>Товар</th>
                  <th colSpan={6}>Продажи</th>
                  <th colSpan={2} className="tooltip-hint" title="Баллы покупателя Ozon и программы софинансирования банков-партнёров — из «Позаказного отчёта о реализации», только за уже закрытые месяцы.">
                    Бонусы Ozon (по отчёту реализации)
                  </th>
                  <th colSpan={12} className="tooltip-hint" title="Каждая категория сборов Ozon — отдельным столбцом. 0 ₽ — такого сбора по товару за период не было. На коротких периодах суммы могут казаться непропорционально большими — см. пояснение под заголовком таблицы.">
                    Комиссии и сборы Ozon
                  </th>
                  <th colSpan={7}>Реклама и продвижение</th>
                  <th colSpan={2}>Итог</th>
                </tr>
                <tr>
                  <th>Название</th>
                  <th>SKU</th>
                  <th className="tooltip-hint" title="Из «Позаказного отчёта о реализации» — только за уже закрытые месяцы.">ШК</th>
                  <th className="tooltip-hint" title="Кол-во проданных штук × себестоимость единицы за период.">Себестоимость проданного</th>
                  <th className="tooltip-hint" title="Выручка по товару за период / кол-во проданных штук.">Цена продажи</th>
                  <th>Продано, шт</th>
                  <th className="tooltip-hint" title="Из «Позаказного отчёта о реализации» — только за уже закрытые месяцы, за весь календарный месяц.">Доставлено, шт</th>
                  <th className="tooltip-hint" title="Из «Позаказного отчёта о реализации» — только за уже закрытые месяцы, за весь календарный месяц.">Возвращено, шт</th>
                  <th>Выручка</th>
                  <th className="tooltip-hint" title="Сумма скидки, покрытая баллами покупателя Ozon. Только за уже закрытые месяцы.">Баллы за скидку</th>
                  <th className="tooltip-hint" title="Софинансирование банков-партнёров по акциям. Только за уже закрытые месяцы.">Партнёрские программы</th>
                  <th className="tooltip-hint" title="Комиссия за продажу + комиссия за бренд + вознаграждение за продажу. Датируется по начислению Ozon, а не по дате заказа — на коротких периодах может не совпадать по составу заказов с «Продано»/«Выручкой» этой строки (см. пояснение под заголовком таблицы).">Комиссия Ozon</th>
                  <th className="tooltip-hint" title="Пока не встречалась в данных этого магазина — появится автоматически, как только Ozon её пришлёт.">Эквайринг</th>
                  <th className="tooltip-hint" title="Приём/обработка отправления, упаковка, кросс-докинг.">Обработка отправлений</th>
                  <th className="tooltip-hint" title="Логистика + курьерская доставка (последняя миля).">Логистика</th>
                  <th>Доставка до места выдачи</th>
                  <th className="tooltip-hint" title="Пока не встречалась в данных этого магазина — появится автоматически, как только Ozon её пришлёт.">Хранение</th>
                  <th className="tooltip-hint" title="Приём возврата в пункте выдачи.">Обработка возвратов</th>
                  <th>Обратная логистика</th>
                  <th className="tooltip-hint" title="Пока не встречалась в данных этого магазина — появится автоматически, как только Ozon её пришлёт.">Утилизация</th>
                  <th className="tooltip-hint" title="Пока не встречалась в данных этого магазина — появится автоматически, как только Ozon её пришлёт.">Доп. обработка ОВХ</th>
                  <th className="tooltip-hint" title="Штраф за просрочку отгрузки, отгрузка в нерекомендованный слот.">Штрафы</th>
                  <th className="tooltip-hint" title="Сборы Ozon, не попавшие ни в одну из категорий выше — сумма нигде не теряется.">Прочие сборы</th>
                  <th>Оплата за клик</th>
                  <th className="tooltip-hint" title="Пока не встречалась в данных этого магазина — появится автоматически, как только Ozon её пришлёт.">Оплата за заказ</th>
                  <th className="tooltip-hint" title="Из «Позаказного отчёта о реализации» — только за уже закрытые месяцы.">Звёздные товары</th>
                  <th>Продвижение бренда</th>
                  <th className="tooltip-hint" title="Пока не встречалась в данных этого магазина — появится автоматически, как только Ozon её пришлёт.">Работа с отзывами</th>
                  <th className="tooltip-hint" title="Доля рекламных расходов от продаж = (Оплата за клик + Оплата за заказ + Звёздные товары + Продвижение бренда) / Выручка. Рубли сверху, % снизу.">ДРР</th>
                  <th className="tooltip-hint" title="Нужна отдельная интеграция с рекламным API Ozon (Performance API) — сейчас не подключена.">CTR</th>
                  <th className="tooltip-hint" title="Выручка минус себестоимость, все сборы Ozon и налог по товару (без учёта баллов/партнёрских программ выше — те данные ещё не проверены на реальных числах, отдельно от подтверждённого расчёта). Рубли сверху, % снизу.">Прибыль за период</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {detail.map((p) => {
                  const meta = statusMeta(p.flag);
                  return (
                    <tr key={p.id} style={{ background: meta.bg }}>
                      <td>{p.name}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{p.sku}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{p.barcode ?? '—'}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.cogsFromTx)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.avgSalePrice !== null ? money(p.avgSalePrice) : '—'}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.quantitySold || '—'}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{qtyCell(p.deliveredQty)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{qtyCell(p.returnedQty)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.revenue)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.bonusAmount !== null ? money(p.bonusAmount) : '—'}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.bankCoinvestmentAmount !== null ? money(p.bankCoinvestmentAmount) : '—'}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.commission)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.acquiring)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.shipmentProcessing)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.logistics)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.deliveryToPickupPoint)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.storage)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.returnsProcessing)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.reverseLogistics)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.disposal)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.ovhProcessing)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.sellerFault)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.other)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.clicks)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.orderAds)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.starsAmount !== null ? money(p.starsAmount) : '—'}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.brandPromo)}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(p.fine.reviews)}</td>
                      <td>{stackedCell(money(p.adSpend), p.drrPercent !== null ? (p.drrPercent * 100).toFixed(1) + '%' : '—')}</td>
                      <td style={{ color: 'var(--text-muted)' }}>—</td>
                      <td>
                        {stackedCell(
                          money(p.periodProfit),
                          p.periodMargin !== null ? (p.periodMargin * 100).toFixed(1) + '%' : '—',
                          p.periodProfit < 0 ? 'var(--bad)' : undefined,
                        )}
                      </td>
                      <td>
                        <span className={`pill ${meta.cls}`} title={p.reason}>
                          {meta.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600, borderTop: '2px solid var(--border)' }}>
                  <td>Итого</td>
                  <td></td>
                  <td></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.cogsFromTx)}</td>
                  <td></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{detailTotals.quantitySold}</td>
                  <td></td>
                  <td></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.revenue)}</td>
                  <td></td>
                  <td></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.commission ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.acquiring ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.shipmentProcessing ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.logistics ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.deliveryToPickupPoint ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.storage ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.returnsProcessing ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.reverseLogistics ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.disposal ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.ovhProcessing ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.sellerFault ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.other ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.clicks ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.orderAds ?? 0)}</td>
                  <td></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.brandPromo ?? 0)}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(detailTotals.fine.reviews ?? 0)}</td>
                  <td>{stackedCell(money(detailTotals.adSpend), detailTotalDrr !== null ? (detailTotalDrr * 100).toFixed(1) + '%' : '—')}</td>
                  <td></td>
                  <td style={{ color: detailTotals.periodProfit < 0 ? 'var(--bad)' : 'inherit' }}>
                    {stackedCell(money(detailTotals.periodProfit), detailTotalMargin !== null ? (detailTotalMargin * 100).toFixed(1) + '%' : '—')}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
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
