import type { AiAdapter, AiCallResult, AiChatMessage, AiCredentials } from '../types';

const API_URL = 'https://api.openai.com/v1/chat/completions';

async function callOpenAi(creds: AiCredentials, system: string, messages: AiChatMessage[], maxTokens: number): Promise<AiCallResult> {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: creds.model,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
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
      const msg = json?.error?.message || `OpenAI вернул ошибку ${res.status}`;
      if (res.status === 401 || res.status === 403) return { ok: false, text: '', message: `Неверный Api-Key (OpenAI: ${msg})` };
      if (res.status === 429) return { ok: false, text: '', message: 'OpenAI временно ограничил число запросов (429). Попробуйте позже.' };
      return { ok: false, text: '', message: msg };
    }
    const content = json?.choices?.[0]?.message?.content ?? '';
    return { ok: true, text: String(content) };
  } catch (e) {
    return { ok: false, text: '', message: `Не удалось связаться с OpenAI: ${(e as Error).message}` };
  }
}

export function createOpenAiAdapter(creds: AiCredentials): AiAdapter {
  return {
    async testConnection() {
      const r = await callOpenAi(creds, 'Ответь ровно одним словом: OK.', [{ role: 'user', content: 'ping' }], 8);
      return r.ok ? { ok: true, message: 'Подключение успешно.' } : { ok: false, message: r.message || 'Ошибка подключения.' };
    },
    async complete(system, messages) {
      return callOpenAi(creds, system, messages, 1400);
    },
  };
}
