export function FreshnessBanner({ dataAsOf, isStale }: { dataAsOf: Date | null; isStale: boolean }) {
  if (!isStale) return null;
  return (
    <div className="attention-item warning" style={{ marginBottom: 20 }}>
      <span className="attention-badge">Проверить</span>
      <div>
        <div className="attention-title">Данные могли устареть</div>
        <div className="attention-detail">
          Последнее обновление: {dataAsOf ? dataAsOf.toLocaleString('ru-RU') : 'данных ещё не было'}. Зайдите в «Проекты» →
          «Магазины Ozon» и нажмите «Синхронизировать», прежде чем доверять этим цифрам.
        </div>
      </div>
    </div>
  );
}
