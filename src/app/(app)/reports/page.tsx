import { requireUser } from '@/lib/authz';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  await requireUser();
  return (
    <div className="panel">
      <h2>Отчёты</h2>
      <div className="stub-note">
        Экспорт понятного отчёта для клиента появится на следующем этапе вместе с ИИ-аналитиком. Пока все цифры
        доступны на «Обзоре», «Товарах» и «Расходах» с раскрытием состава по клику.
      </div>
    </div>
  );
}
