import { inputDate } from '@/lib/period';

type ProjectOption = {
  id: string;
  name: string;
  client: { name: string };
  stores: { id: string; name: string }[];
};

export function FilterBar({
  basePath,
  projects,
  selectedProjectId,
  selectedStoreId,
  from,
  to,
  dateBasis,
}: {
  basePath: string;
  projects: ProjectOption[];
  selectedProjectId: string;
  selectedStoreId?: string;
  from: Date;
  to: Date;
  /** Показывать выбор «по какой дате считать период» — только там, где это уже подключено
   *  (см. computeProductInsights/computeFinanceSummary — DateBasis). Необязательный проп: на
   *  страницах, где его не передали, выбор просто не показывается и поведение не меняется. */
  dateBasis?: 'order' | 'accrual';
}) {
  const selected = projects.find((p) => p.id === selectedProjectId) ?? projects[0];

  return (
    <form method="get" action={basePath} className="topbar">
      <div className="field">
        <label>Магазин</label>
        <select name="projectId" defaultValue={selected?.id}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.client.name} · {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Период с</label>
        <input type="date" name="from" defaultValue={inputDate(from)} />
      </div>
      <div className="field">
        <label>по</label>
        <input type="date" name="to" defaultValue={inputDate(to)} />
      </div>
      {dateBasis && (
        <div className="field">
          <label className="tooltip-hint" title="«По дате заказа» — когда покупатель оформил заказ (как раньше). «По дате начисления Ozon» — когда площадка провела начисление по отправлению, обычно на несколько дней позже; так считают официальные отчёты Ozon (например, «Отчёт по начислениям») — выбирайте её, если сверяете цифры с таким отчётом.">
            Период по дате
          </label>
          <select name="dateBasis" defaultValue={dateBasis}>
            <option value="order">Заказа</option>
            <option value="accrual">Начисления Ozon</option>
          </select>
        </div>
      )}
      <button className="btn btn-primary" type="submit">
        Показать
      </button>
    </form>
  );
}
