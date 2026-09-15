import { redirect } from 'next/navigation';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

async function acceptInviteAction(formData: FormData) {
  'use server';
  const token = String(formData.get('token') || '');
  const password = String(formData.get('password') || '');
  const password2 = String(formData.get('password2') || '');
  if (!token) return;

  if (password.length < 8) {
    redirect(`/invite/${token}?error=${encodeURIComponent('Пароль должен быть не короче 8 символов.')}`);
  }
  if (password !== password2) {
    redirect(`/invite/${token}?error=${encodeURIComponent('Пароли не совпадают.')}`);
  }

  const invite = await prisma.inviteToken.findUnique({ where: { token } });
  if (!invite || invite.usedAt || invite.expiresAt < new Date()) {
    redirect(
      `/invite/${token}?error=${encodeURIComponent('Ссылка недействительна, устарела или уже использована — попросите администратора отправить новую.')}`,
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.$transaction([
    prisma.user.update({ where: { id: invite!.userId }, data: { passwordHash, inviteAcceptedAt: new Date() } }),
    prisma.inviteToken.update({ where: { id: invite!.id }, data: { usedAt: new Date() } }),
  ]);

  redirect('/login?welcome=1');
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { error?: string };
}) {
  const invite = await prisma.inviteToken.findUnique({ where: { token: params.token }, include: { user: true } });
  const invalid = !invite || !!invite.usedAt || invite.expiresAt < new Date();

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Задайте пароль</h1>
        {invalid ? (
          <p className="error-text">
            Ссылка недействительна, устарела или уже использована. Попросите администратора отправить приглашение ещё
            раз («Настройки» → «Пользователи» → «Отправить ссылку ещё раз»).
          </p>
        ) : (
          <>
            <p className="sub">
              {invite!.user.name}, придумайте пароль для входа ({invite!.user.email}).
            </p>
            {searchParams.error && <div className="error-text">{searchParams.error}</div>}
            <form action={acceptInviteAction}>
              <input type="hidden" name="token" value={params.token} />
              <input type="password" name="password" placeholder="Новый пароль (мин. 8 символов)" required minLength={8} />
              <input type="password" name="password2" placeholder="Повторите пароль" required minLength={8} />
              <button className="btn btn-primary" type="submit">
                Сохранить и перейти ко входу
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
