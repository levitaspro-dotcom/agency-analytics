export const ANALYST_SYSTEM_PROMPT = `Ты — ИИ-аналитик внутри панели агентства по маркетплейсам. Ты объясняешь пользователю
(менеджеру агентства или клиенту) финансовые показатели его магазина на Ozon.

СТРОГИЕ ПРАВИЛА, их нельзя нарушать:
1. Ты НИКОГДА не считаешь и не пересчитываешь финансовые показатели сам(а). Ниже в контексте дана уже
   рассчитанная детерминированным финансовым модулем сводка — используй только эти цифры. Если для ответа
   не хватает данных из сводки — прямо скажи об этом, не придумывай числа.
2. Тебе никогда не передаются и не нужны пароли, API-ключи, платёжные реквизиты или персональные данные
   покупателей — если пользователь спросит о них, объясни, что у тебя нет и не может быть такого доступа.
3. Если сводка помечена как устаревшая — обязательно предупреди об этом в начале ответа.
4. Отвечай по-русски, по существу, короткими абзацами или списком, без общих фраз и воды.
5. Если тебя прямо просят посчитать что-то, чего нет в сводке (например, спрогнозировать точную сумму) —
   объясни, что это не входит в твою задачу, и предложи, какую цифру для этого нужно добавить в систему.`;

export function buildRecommendationPrompt(question?: string) {
  return `На основе сводки в системном контексте сформируй ОДНУ конкретную рекомендацию.
Ответь СТРОГО валидным JSON без markdown-обрамления и без текста вне JSON, со следующими полями:
{
  "problem": "краткое описание проблемы или возможности (1-2 предложения)",
  "scope": "к чему это относится: весь проект / магазин / товар / категория расходов — назови конкретно",
  "metrics": "какие именно цифры из сводки подтверждают вывод — процитируй их",
  "action": "конкретное рекомендуемое действие",
  "priority": "low | medium | high",
  "expectedEffect": "ожидаемый эффект с обоснованием, ТОЛЬКО если его можно логически вывести из цифр сводки; если обоснованно оценить нельзя — верни null, не выдумывай",
  "assumptions": "какие допущения ты сделал(а) при выводе",
  "evidence": "на какие именно строки сводки опирается рекомендация"
}
${question ? `Учти отдельный фокус от пользователя: ${question}` : 'Проанализируй сводку целиком и выбери самую важную для бизнеса рекомендацию.'}`;
}

export interface ParsedRecommendation {
  problem: string;
  scope: string;
  metrics: string;
  action: string;
  priority: 'low' | 'medium' | 'high';
  expectedEffect: string | null;
  assumptions: string;
  evidence: string;
}

/** Разбирает ответ модели в структурированную рекомендацию. Модель иногда оборачивает
 *  JSON в ```-блок или добавляет пояснение вокруг — вырезаем первый валидный JSON-объект. */
export function parseRecommendation(raw: string): ParsedRecommendation | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const problem = str(obj.problem);
  const scope = str(obj.scope);
  const metrics = str(obj.metrics);
  const action = str(obj.action);
  const assumptions = str(obj.assumptions) ?? '—';
  const evidence = str(obj.evidence) ?? '—';
  const priorityRaw = typeof obj.priority === 'string' ? obj.priority.toLowerCase().trim() : '';
  const priority: 'low' | 'medium' | 'high' = priorityRaw === 'high' || priorityRaw === 'low' ? priorityRaw : 'medium';
  const expectedEffect = obj.expectedEffect === null || obj.expectedEffect === undefined ? null : str(obj.expectedEffect);

  if (!problem || !scope || !metrics || !action) return null;
  return { problem, scope, metrics, action, priority, expectedEffect, assumptions, evidence };
}
