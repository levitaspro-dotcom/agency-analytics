import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';
import { requireUser } from '@/lib/authz';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Главный администратор',
  MANAGER: 'Менеджер',
  CLIENT: 'Клиент',
};

async function createUserAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const name = String(formData.get('name') || '').trim();
  const role = String(formData.get('role') || 'CLIENT');
  const password = String(formData.get('password') || '');
  if (!email || !name || password.length < 8) return;
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.create({ data: { email, name, role: role as 'SUPER_ADMIN' | 'MANAGER' | 'CLIENT', passwordHash } });
  await prisma.activityLog.create({
    data: { actorId: admin.id, actorName: admin.name, action: 'user.create', targetType: 'User', targetId: email, meta: { role, name } },
  });
  revalidatePath('/settings');
}

async function deleteUserAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const userId = String(formData.get('userId') || '');
  if (!userId) return;

  if (userId === admin.id) {
    throw new Error('Нельзя удалить свою же учётную запись.');
  }

  const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (target.role === 'SUPER_ADMIN') {
    const adminsLeft = await prisma.user.count({ where: { role: 'SUPER_ADMIN' } });
    if (adminsLeft <= 1) {
      throw new Error('Нельзя удалить последнего главного администратора.');
    }
  }

  // Назначения на проекты удаляются вместе с пользователем; записи в истории действий,
  // где он был исполнителем, остаются (с сохранённым именем), но отвязываются от аккаунта.
  await prisma.$transaction([
    prisma.projectAssignment.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);

  await prisma.activityLog.create({
    data: {
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.delete',
      targetType: 'User',
      targetId: userId,
      meta: { email: target.email, name: target.name, role: target.role },
    },
  });
  revalidatePath('/settings');
  revalidatePath('/projects');
}

export default async function SettingsPage() {
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') redirect('/dashboard');

  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
  const activity = await prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 30, include: { actor: true } });

  return (
    <div>
      <div className="panel">
        <h2>Настройки → ИИ</h2>
        <div className="stub-note">
          Подключение провайдера ИИ (адрес API, ключ, модель, разрешённые функции, лимиты, проверка подключения) —
          общее для сервиса и отдельное на проект — реализуется на следующем этапе как заменяемый серверный адаптер,
          без привязки к конкретной модели. Ключи не будут раскрываться в интерфейсе даже администратору: только
          «заменить» и «проверить подключение». Отсутствие подключения не влияет на работу дашборда.
        </div>
      </div>

      <div className="panel">
        <h2>Интеграции Ozon</h2>
        <div className="stub-note">
          Автоматическая синхронизация с личным кабинетом Ozon (заказы, комиссии, реклама, остатки) войдёт в
          следующий этап. Сейчас данные вносятся как финансовые операции проекта (см. модель `FinanceTransaction`).
        </div>
      </div>

      <div className="panel">
        <h2>Пользователи</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Email</th>
              <th>Роль</th>
              <th>Создан</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{ROLE_LABEL[u.role] ?? u.role}</td>
                <td>{u.createdAt.toLocaleDateString('ru-RU')}</td>
                <td>
                  {u.id === user.id ? (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>это вы</span>
                  ) : (
                    <form action={deleteUserAction}>
                      <input type="hidden" name="userId" value={u.id} />
                      <button className="btn btn-danger" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                        Удалить
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 10 }}>
          Удаление отзывает у пользователя все назначения на проекты и вход в систему; последнего главного
          администратора удалить нельзя.
        </p>

        <h3>Добавить пользователя</h3>
        <form action={createUserAction} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="text" name="name" placeholder="Имя" required />
          <input type="email" name="email" placeholder="Email" required />
          <input type="password" name="password" placeholder="Пароль (мин. 8 символов)" required minLength={8} />
          <select name="role" defaultValue="MANAGER">
            <option value="MANAGER">Менеджер</option>
            <option value="CLIENT">Клиент</option>
            <option value="SUPER_ADMIN">Главный администратор</option>
          </select>
          <button className="btn btn-primary" type="submit">
            Создать
          </button>
        </form>
      </div>

      <div className="panel">
        <h2>История действий</h2>
        {activity.length === 0 ? (
          <div className="empty-state">Действий пока нет.</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Кто</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((a) => (
                <tr key={a.id}>
                  <td>{a.createdAt.toLocaleString('ru-RU')}</td>
                  <td>{a.actorName ?? a.actor?.name ?? 'Удалённый пользователь'}</td>
                  <td>{a.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
