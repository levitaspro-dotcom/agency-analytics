import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { sendEmail, inviteEmailHtml } from '@/lib/email';

export function baseUrl() {
  return (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');
}

// Защита от случайной отправки нескольких писем подряд (двойной клик, повторная отправка
// формы, повтор запроса браузером и т.п.): если для этого пользователя уже выпускалась
// непринятая ссылка за последние 30 секунд, повторно не создаём токен и не шлём письмо —
// отдаём ту же самую ссылку, которую уже отправили.
const REISSUE_COOLDOWN_MS = 30_000;

type RecentInviteRow = { token: string };

/**
 * Создаёт одноразовую ссылку-приглашение (живёт 7 дней) и пытается отправить её на почту
 * через Resend. Если email-сервис не настроен или письмо не ушло — не делаем вид, что всё
 * получилось: возвращаем саму ссылку, чтобы админ мог передать её вручную.
 *
 * Общая для Настроек (создание логина менеджера/продавца) и страницы «Продавцы и магазины»
 * (форма «Дать доступ» прямо в карточке продавца).
 */
export async function issueInvite(userId: string, email: string, name: string) {
  const recent = (await prisma.inviteToken.findFirst({
    where: { userId, usedAt: null, createdAt: { gt: new Date(Date.now() - REISSUE_COOLDOWN_MS) } },
    orderBy: { createdAt: 'desc' },
    select: { token: true },
  })) as RecentInviteRow | null;
  if (recent) {
    return {
      link: `${baseUrl()}/invite/${recent.token}`,
      result: { ok: true, message: 'Ссылка уже была отправлена несколько секунд назад — повторное письмо не отправлено.' },
    };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await prisma.inviteToken.create({ data: { userId, token, expiresAt } });
  const link = `${baseUrl()}/invite/${token}`;
  const result = await sendEmail({ to: email, subject: 'Доступ к панели аналитики', html: inviteEmailHtml({ name, link }) });
  return { link, result };
}
