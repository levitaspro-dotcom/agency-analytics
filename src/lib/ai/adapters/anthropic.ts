import type { AiAdapter, AiCallResult, AiChatMessage, AiCredentials } from '../types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

async function callAnthropic(creds: AiCredentials, system: string, messages: AiChatMessage[], maxTokens: number): Promise<AiCallResult> {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': creds.apiKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: creds.model,
        max_tokens: maxTokens,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
      cache: 'no-store',
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = json?.error?.message || `Anthropic вернул ошибку ${res.status}`;
      if (res.status === 401 || res.status === 403) return { ok: false, text: '', message: `Неверный Api-Key (Anthropic: ${msg})` };
      if (res.status === 429) return { ok: false, text: '', message: 'Anthropic временно ограничил число запросов (429). Попробуйте позже.' };
      return { ok: false, text: '', message: msg };
    }
    const content = Array.isArray(json?.content) ? json.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('') : '';
    return { ok: true, text: content };
  } catch (e) {
    return { ok: false, text: '', message: `Не удалось связаться с Anthropic: ${(e as Error).message}` };
  }
}

export function createAnthropicAdapter(creds: AiCredentials): AiAdapter {
  return {
    async testConnection() {
      const r = await callAnthropic(creds, 'Ответь ровно одним словом: OK.', [{ role: 'user', content: 'ping' }], 8);
      return r.ok ? { ok: true, message: 'Подключение успешно.' } : { ok: false, message: r.message || 'Ошибка подключения.' };
    },
    async complete(system, messages) {
      return callAnthropic(creds, system, messages, 1400);
    },
  };
}
