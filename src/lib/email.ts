/**
 * Отправка писем через Resend (https://resend.com) — обычный HTTP API-запрос,
 * без отдельной библиотеки. Настраивается двумя переменными окружения:
 *   RESEND_API_KEY   — ключ API из личного кабинета Resend.
 *   RESEND_FROM_EMAIL — адрес отправителя (домен должен быть подтверждён в Resend).
 *
 * Если ключ не задан — не притворяемся, что письмо ушло: возвращаем ok:false с понятным
 * сообщением, чтобы вызывающий код мог показать администратору ссылку для отправки вручную,
 * а не просто "письмо отправлено" в пустоту.
 */
export async function sendEmail(params: { to: string; subject: string; html: string }): Promise<{ ok: boolean; message: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!apiKey || !from) {
    return { ok: false, message: 'Email-сервис не настроен (нет RESEND_API_KEY/RESEND_FROM_EMAIL) — ссылку нужно передать вручную.' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [params.to], subject: params.subject, html: params.html }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.message || JSON.stringify(j);
      } catch {
        detail = await res.text();
      }
      return { ok: false, message: `Resend вернул ошибку (${res.status}): ${detail}` };
    }
    return { ok: true, message: 'Письмо отправлено.' };
  } catch (e) {
    return { ok: false, message: `Не удалось связаться с Resend: ${(e as Error).message}` };
  }
}

export function inviteEmailHtml(params: { name: string; link: string }): string {
  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>Добро пожаловать!</h2>
      <p>${params.name}, для вас создан доступ к панели аналитики агентства.</p>
      <p>Чтобы задать пароль и войти, перейдите по ссылке (действует 7 дней):</p>
      <p><a href="${params.link}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Задать пароль и войти</a></p>
      <p style="color:#666;font-size:13px;">Если ссылка не открывается, скопируйте её целиком в браузер:<br>${params.link}</p>
    </div>
  `;
}
