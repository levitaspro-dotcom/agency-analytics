import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { requireUser } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { encryptSecret, decryptSecret, last4 } from '@/lib/crypto';
import { createAdapter } from '@/lib/ai';
import { issueInvite } from '@/lib/invite';

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Главный администратор',
  MANAGER: 'Менеджер',
  CLIENT: 'Продавец',
};

const AI_PROVIDER_LABEL: Record<string, string> = {
  ANTHROPIC: 'Anthropic Claude',
  OPENAI: 'OpenAI',
};

async function createUserAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const name = String(formData.get('name') || '').trim();
  const role = String(formData.get('role') || 'CLIENT');
  // Продавец, за которым закреплён логин — имеет смысл только для роли «Продавец» (CLIENT).
  const clientId = role === 'CLIENT' ? String(formData.get('clientId') || '').trim() || null : null;
  if (!email || !name) return;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    redirect(`/settings?inviteError=${encodeURIComponent('Пользователь с таким email уже есть.')}`);
  }

  // Пароль никто не вводит и не видит — случайная строка только для того, чтобы поле было
  // непустым. Войти можно только через ссылку из письма, где пользователь сам задаёт пароль.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  const user = await prisma.user.create({
    data: { email, name, role: role as 'SUPER_ADMIN' | 'MANAGER' | 'CLIENT', clientId, passwordHash },
  });
  await prisma.activityLog.create({
    data: { actorId: admin.id, actorName: admin.name, action: 'user.create', targetType: 'User', targetId: email, meta: { role, name, clientId } },
  });

  const { link, result } = await issueInvite(user.id, email, name);
  await prisma.activityLog.create({
    data: {
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.invite',
      targetType: 'User',
      targetId: user.id,
      meta: { email, emailSent: result.ok, emailMessage: result.message },
    },
  });
  revalidatePath('/settings');
  if (!result.ok) {
    redirect(`/settings?inviteLink=${encodeURIComponent(link)}&inviteEmail=${encodeURIComponent(email)}`);
  }
}

async function resendInviteAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const userId = String(formData.get('userId') || '');
  if (!userId) return;
  const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (target.inviteAcceptedAt) return;

  const { link, result } = await issueInvite(target.id, target.email, target.name);
  await prisma.activityLog.create({
    data: {
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.reinvite',
      targetType: 'User',
      targetId: userId,
      meta: { email: target.email, emailSent: result.ok, emailMessage: result.message },
    },
  });
  revalidatePath('/settings');
  if (!result.ok) {
    redirect(`/settings?inviteLink=${encodeURIComponent(link)}&inviteEmail=${encodeURIComponent(target.email)}`);
  }
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

async function changeUserRoleAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const userId = String(formData.get('userId') || '');
  const role = String(formData.get('role') || '');
  if (!userId || !['SUPER_ADMIN', 'MANAGER', 'CLIENT'].includes(role)) return;

  const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (target.role === role) return;

  // Нельзя понизить последнего главного администратора — иначе никто не сможет управлять
  // пользователями и настройками.
  if (target.role === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN') {
    const adminsLeft = await prisma.user.count({ where: { role: 'SUPER_ADMIN' } });
    if (adminsLeft <= 1) {
      throw new Error('Нельзя понизить последнего главного администратора.');
    }
  }

  await prisma.user.update({ where: { id: userId }, data: { role: role as 'SUPER_ADMIN' | 'MANAGER' | 'CLIENT' } });
  await prisma.activityLog.create({
    data: {
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.changeRole',
      targetType: 'User',
      targetId: userId,
      meta: { email: target.email, from: target.role, to: role },
    },
  });
  revalidatePath('/settings');
}

async function saveAiProviderAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const provider = String(formData.get('provider') || 'ANTHROPIC') as 'ANTHROPIC' | 'OPENAI';
  const model = String(formData.get('model') || '').trim();
  const apiKey = String(formData.get('apiKey') || '').trim();
  if (!model || !apiKey) return;

  // Предыдущая конфигурация не удаляется (остаётся в истории), а деактивируется —
  // активна всегда ровно одна. Старый ключ нигде повторно не показывается.
  await prisma.$transaction([
    prisma.aiProviderConfig.updateMany({ where: { active: true }, data: { active: false } }),
    prisma.aiProviderConfig.create({
      data: { provider, model, apiKeyEncrypted: encryptSecret(apiKey), apiKeyLast4: last4(apiKey), active: true },
    }),
  ]);
  await prisma.activityLog.create({
    data: { actorId: admin.id, actorName: admin.name, action: 'ai.configure', targetType: 'AiProviderConfig', meta: { provider, model } },
  });
  revalidatePath('/settings');
  revalidatePath('/ai-analyst');
}

async function testAiProviderAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const configId = String(formData.get('configId') || '');
  const config = configId ? await prisma.aiProviderConfig.findUnique({ where: { id: configId } }) : null;
  if (!config) return;

  const adapter = createAdapter(config.provider, { apiKey: decryptSecret(config.apiKeyEncrypted), model: config.model });
  const result = await adapter.testConnection();

  await prisma.aiProviderConfig.update({
    where: { id: config.id },
    data: { lastTestAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message },
  });
  await prisma.activityLog.create({
    data: { actorId: admin.id, actorName: admin.name, action: 'ai.testConnection', targetType: 'AiProviderConfig', targetId: config.id, meta: result },
  });
  revalidatePath('/settings');
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { inviteLink?: string; inviteEmail?: string; inviteError?: string };
}) {
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') redirect('/dashboard');

  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' }, include: { client: true } });
  const clients = await prisma.client.findMany({ orderBy: { name: 'asc' } });
  const activity = await prisma.activityLog.findMany({ orderBy: { createdAt: 'desc' }, take: 30, include: { actor: true } });
  const aiConfig = await prisma.aiProviderConfig.findFirst({ where: { active: true }, orderBy: { updatedAt: 'desc' } });

  return (
    <div>
      {searchParams.inviteError && (
        <div className="panel" style={{ borderColor: 'var(--bad)' }}>
          <div style={{ color: 'var(--bad)', fontWeight: 600 }}>{searchParams.inviteError}</div>
        </div>
      )}
      {searchParams.inviteLink && (
        <div className="panel">
          <h2>Ссылка-приглашение для {searchParams.inviteEmail}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -8, marginBottom: 10 }}>
            Письмо отправить не удалось (см. историю действий ниже — там причина) — передайте ссылку вручную, она
            действует 7 дней:
          </p>
          <code style={{ display: 'block', padding: '8px 10px', background: 'var(--bg-muted, #f4f4f5)', borderRadius: 6, wordBreak: 'break-all', fontSize: 12.5 }}>
            {searchParams.inviteLink}
          </code>
        </div>
      )}
      <div className="panel">
        <h2>Настройки → ИИ</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -8, marginBottom: 14 }}>
          Провайдер подключается как заменяемый серверный адаптер — не привязан к конкретной модели. Ключ хранится в
          зашифрованном виде и повторно нигде не показывается — только последние 4 символа. Отсутствие подключения не
          влияет на работу финансового дашборда, только на раздел «ИИ-аналитик».
        </p>

        {aiConfig ? (
          <div style={{ marginBottom: 16, fontSize: 13.5 }}>
            <div style={{ marginBottom: 4 }}>
              <b>{AI_PROVIDER_LABEL[aiConfig.provider] ?? aiConfig.provider}</b> · модель <code>{aiConfig.model}</code> · ключ
              ••••{aiConfig.apiKeyLast4}
            </div>
            <div style={{ marginBottom: 8 }}>
              {aiConfig.lastTestAt ? (
                <span className={`pill ${aiConfig.lastTestOk ? 'ok' : 'critical'}`}>{aiConfig.lastTestOk ? 'Подключено' : 'Ошибка'}</span>
              ) : (
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>ещё не проверялось</span>
              )}
              {aiConfig.lastTestMessage && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>{aiConfig.lastTestMessage}</span>
              )}
            </div>
            <form action={testAiProviderAction}>
              <input type="hidden" name="configId" value={aiConfig.id} />
              <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                Проверить подключение
              </button>
            </form>
          </div>
        ) : (
          <div className="empty-state" style={{ padding: '10px 0' }}>ИИ пока не подключён.</div>
        )}

        <h3>{aiConfig ? 'Заменить провайдера' : 'Подключить провайдера'}</h3>
        <form action={saveAiProviderAction} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select name="provider" defaultValue="ANTHROPIC">
            <option value="ANTHROPIC">Anthropic Claude</option>
            <option value="OPENAI">OpenAI</option>
          </select>
          <input type="text" name="model" placeholder="Например, claude-sonnet-4-5" required style={{ minWidth: 200 }} />
          <input type="password" name="apiKey" placeholder="Api-Key" autoComplete="off" required />
          <button className="btn btn-primary" type="submit">
            Сохранить
          </button>
        </form>
      </div>

      <div className="panel">
        <h2>Интеграции Ozon</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -8, marginBottom: 0 }}>
          Подключение магазинов (Client-Id/Api-Key), проверка подключения и синхронизация финансовых операций
          выполняются в разделе <a href="/projects">«Магазины и команда»</a>, отдельно по каждому магазину.
        </p>
      </div>

      <div className="panel">
        <h2>Пользователи</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Email</th>
              <th>Роль</th>
              <th>Продавец</th>
              <th>Статус</th>
              <th>Создан</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <form action={changeUserRoleAction} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input type="hidden" name="userId" value={u.id} />
                    <select name="role" defaultValue={u.role} style={{ fontSize: 12, padding: '2px 4px' }}>
                      <option value="SUPER_ADMIN">Главный администратор</option>
                      <option value="MANAGER">Менеджер</option>
                      <option value="CLIENT">Продавец</option>
                    </select>
                    <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} type="submit">
                      Сохранить
                    </button>
                  </form>
                </td>
                <td>{u.client?.name ?? '—'}</td>
                <td>
                  {u.inviteAcceptedAt ? (
                    <span className="pill ok">Активен</span>
                  ) : (
                    <div>
                      <span className="pill warning" style={{ marginBottom: 4, display: 'inline-block' }}>
                        Ждёт входа по ссылке
                      </span>
                      <form action={resendInviteAction}>
                        <input type="hidden" name="userId" value={u.id} />
                        <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} type="submit">
                          Отправить ссылку ещё раз
                        </button>
                      </form>
                    </div>
                  )}
                </td>
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
          Удаление отзывает у пользователя все назначения на магазины и вход в систему; последнего главного
          администратора удалить нельзя. Пароль никто не вводит — при создании на почту уходит ссылка, по которой
          человек сам задаёт себе пароль и получает доступ.
        </p>

        <h3>Добавить пользователя</h3>
        <form action={createUserAction} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="text" name="name" placeholder="Имя" required />
          <input type="email" name="email" placeholder="Email" required />
          <select name="role" defaultValue="MANAGER">
            <option value="MANAGER">Менеджер</option>
            <option value="CLIENT">Продавец</option>
            <option value="SUPER_ADMIN">Главный администратор</option>
          </select>
          <select name="clientId" defaultValue="" title="Только для роли «Продавец» — за каким продавцом закрепить логин">
            <option value="">— не привязан к продавцу —</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" type="submit">
            Создать и отправить приглашение
          </button>
        </form>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>
          Продавца из списка выше указывайте только для роли «Продавец» — для менеджеров и администраторов он
          игнорируется. Для продавца доступ удобнее выдавать прямо в его карточке в разделе «Магазины и команда» —
          там же видно, дан ли ему уже доступ.
        </p>
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
