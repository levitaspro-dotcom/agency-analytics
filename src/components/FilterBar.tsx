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
}: {
  basePath: string;
  projects: ProjectOption[];
  selectedProjectId: string;
  selectedStoreId?: string;
  from: Date;
  to: Date;
}) {
  const selected = projects.find((p) => p.id === selectedProjectId) ?? projects[0];

  return (
    <form method="get" action={basePath} className="topbar">
      <div className="field">
        <label>Проект</label>
        <select name="projectId" defaultValue={selected?.id}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.client.name} · {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Магазин</label>
        <select name="storeId" defaultValue={selectedStoreId ?? ''}>
          <option value="">Все магазины проекта</option>
          {selected?.stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
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
      <button className="btn btn-primary" type="submit">
        Показать
      </button>
    </form>
  );
}
