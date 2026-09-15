import { requireUser } from '@/lib/authz';

export const dynamic = 'force-dynamic';

export default async function AiAnalystPage() {
  await requireUser();
  return (
    <div>
      <div className="panel">
        <h2>ИИ-аналитик</h2>
        <div className="stub-note">
          ИИ не подключён. Раздел «Настройки → ИИ» и сам ИИ-аналитик (аудит, поиск аномалий, рекомендации с историей)
          войдут в следующий этап разработки — через заменяемые серверные адаптеры, без изменений в остальной части
          приложения. Финансовые расчёты уже работают независимо от ИИ — см. «Обзор», «Товары» и «Расходы».
        </div>
      </div>
    </div>
  );
}
