import type { AiAdapter, AiCredentials } from './types';
import { createAnthropicAdapter } from './adapters/anthropic';
import { createOpenAiAdapter } from './adapters/openai';

export type { AiAdapter, AiChatMessage, AiCallResult, AiCredentials } from './types';

/**
 * Единственное место, которое знает о существовании конкретных провайдеров.
 * Добавление нового провайдера — это новый файл в adapters/ и одна строка здесь,
 * без изменений в остальном приложении (страницы и server actions работают только
 * с интерфейсом AiAdapter).
 */
export function createAdapter(provider: 'ANTHROPIC' | 'OPENAI', creds: AiCredentials): AiAdapter {
  switch (provider) {
    case 'ANTHROPIC':
      return createAnthropicAdapter(creds);
    case 'OPENAI':
      return createOpenAiAdapter(creds);
    default:
      throw new Error(`Неизвестный провайдер ИИ: ${provider}`);
  }
}
