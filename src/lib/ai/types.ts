/**
 * Общий интерфейс адаптера ИИ-провайдера. Вся специфика конкретного API (Anthropic,
 * OpenAI, ...) — внутри adapters/*.ts; остальное приложение работает только с этим
 * интерфейсом и легко переживёт смену или добавление провайдера.
 */

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiCallResult {
  ok: boolean;
  text: string;
  message?: string;
}

export interface AiCredentials {
  apiKey: string;
  model: string;
}

export interface AiAdapter {
  testConnection(): Promise<{ ok: boolean; message: string }>;
  complete(system: string, messages: AiChatMessage[]): Promise<AiCallResult>;
}
