import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser, listAccessibleProjects, assertProjectAccess, ForbiddenError } from '@/lib/authz';
import { resolvePeriod, inputDate } from '@/lib/period';
import { prisma } from '@/lib/prisma';
import { FilterBar } from '@/components/FilterBar';
import { FreshnessBanner } from '@/components/FreshnessBanner';
import { buildProjectAiContext } from '@/lib/ai/context';
import { getActiveAiAdapter } from '@/lib/ai/config';
import { ANALYST_SYSTEM_PROMPT, buildRecommendationPrompt, parseRecommendation } from '@/lib/ai/prompts';
import type { AiChatMessage } from '@/lib/ai';

export const dynamic = 'force-dynamic';

const PRIORITY_LABEL: Record<string, string> = { high: 'Высокий приоритет', medium: 'Средний приоритет', low: 'Низкий приоритет' };
const PRIORITY_PILL: Record<string, string> = { high: 'critical', medium: 'warning', low: 'ok' };

async function askAnalystAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  const projectId = String(formData.get('projectId') || '');
  const storeId = String(formData.get('storeId') || '') || undefined;
  const question = String(formData.get('question') || '').trim();
  const { from, to } = resolvePeriod({ from: String(formData.get('from') || ''), to: String(formData.get('to') || '') });
  if (!projectId || !question) return;
  await assertProjectAccess(user, projectId);

  await prisma.aiMessage.create({
    data: { projectId, userId: user.id, userName: user.name, role: 'user', content: question },
  });

  const active = await getActiveAiAdapter();
  if (!active) {
    await prisma.aiMessage.create({
      data: { projectId, role: 'assistant', content: 'ИИ-провайдер пока не настроен. Обратитесь к главному администратору: «Настройки → ИИ».' },
    });
    revalidatePath('/ai-analyst');
    return;
  }

  const ctx = await buildProjectAiContext({ projectId, storeId, from, to });
  const history = await prisma.aiMessage.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 12 });
  const priorTurns = history.reverse().slice(0, -1); // без только что сохранённого вопроса — добавим его явно ниже

  const chatMessages: AiChatMessage[] = [
    ...priorTurns.map((m) => ({ role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: question },
  ];

  const result = await active.adapter.complete(`${ANALYST_SYSTEM_PROMPT}\n\nКОНТЕКСТ:\n${ctx.text}`, chatMessages);

  await prisma.aiMessage.create({
    data: {
      projectId,
      role: 'assistant',
      content: result.ok ? result.text : `Не удалось получить ответ от ИИ: ${result.message}`,
      dataAsOf: ctx.dataAsOf,
    },
  });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'ai.ask', targetType: 'Project', targetId: projectId, meta: { ok: result.ok } },
  });
  revalidatePath('/ai-analyst');
}

async function generateRecommendationAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  const projectId = String(formData.get('projectId') || '');
  const storeId = String(formData.get('storeId') || '') || undefined;
  const focus = String(formData.get('focus') || '').trim();
  const { from, to } = resolvePeriod({ from: String(formData.get('from') || ''), to: String(formData.get('to') || '') });
  if (!projectId) return;
  await assertProjectAccess(user, projectId);

  const active = await getActiveAiAdapter();
  const ctx = await buildProjectAiContext({ projectId, storeId, from, to });
  const evidenceHref = `/dashboard?projectId=${projectId}${storeId ? `&storeId=${storeId}` : ''}&from=${inputDate(from)}&to=${inputDate(to)}`;

  if (!active) {
    revalidatePath('/ai-analyst');
    return;
  }

  const result = await active.adapter.complete(`${ANALYST_SYSTEM_PROMPT}\n\nКОНТЕКСТ:\n${ctx.text}`, [
    { role: 'user', content: buildRecommendationPrompt(focus || undefined) },
  ]);

  if (!result.ok) {
    await prisma.aiRecommendation.create({
      data: {
        projectId,
        createdByUserId: user.id,
        createdByName: user.name,
        problem: 'Не удалось получить рекомендацию от ИИ',
        scope: '—',
        metrics: '—',
        action: '—',
        priority: 'low',
        expectedEffect: null,
        assumptions: '—',
        evidence: result.message || 'ошибка обращения к ИИ',
        evidenceHref,
        dataAsOf: ctx.dataAsOf ?? new Date(),
        rawModelOutput: result.message ?? null,
      },
    });
    revalidatePath('/ai-analyst');
    return;
  }

  const parsed = parseRecommendation(result.text);
  await prisma.aiRecommendation.create({
    data: {
      projectId,
      createdByUserId: user.id,
      createdByName: user.name,
      problem: parsed?.problem ?? 'Не удалось разобрать структурированный ответ ИИ — см. необработанный текст в истории.',
      scope: parsed?.scope ?? '—',
      metrics: parsed?.metrics ?? '—',
      action: parsed?.action ?? '—',
      priority: parsed?.priority ?? 'medium',
      expectedEffect: parsed?.expectedEffect ?? null,
      assumptions: parsed?.assumptions ?? '—',
      evidence: parsed?.evidence ?? '—',
      evidenceHref,
      dataAsOf: ctx.dataAsOf ?? new Date(),
      rawModelOutput: result.text,
    },
  });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'ai.recommendation', targetType: 'Project', targetId: projectId, meta: { ok: !!parsed } },
  });
  revalidatePath('/ai-analyst');
}

export default async function AiAnalystPage({
  searchParams,
}: {
  searchParams: { projectId?: string; storeId?: string; from?: string; to?: string };
}) {
  const user = await requireUser();
  const projects = await listAccessibleProjects(user);

  if (projects.length === 0) {
    return <div className="empty-state">У вас пока нет доступных магазинов. Обратитесь к администратору.</div>;
  }

  const projectId = searchParams.projectId && projects.some((p) => p.id === searchParams.projectId) ? searchParams.projectId : projects[0].id;

  try {
    await assertProjectAccess(user, projectId);
  } catch (e) {
    if (e instanceof ForbiddenError) redirect('/ai-analyst');
    throw e;
  }

  const storeId = searchParams.storeId || undefined;
  const { from, to } = resolvePeriod(searchParams);

  const active = await getActiveAiAdapter();
  const ctx = await buildProjectAiContext({ projectId, storeId, from, to });

  const [messages, recommendations] = await Promise.all([
    prisma.aiMessage.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' }, take: 50 }),
    prisma.aiRecommendation.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);

  return (
    <div>
      <FilterBar basePath="/ai-analyst" projects={projects} selectedProjectId={projectId} selectedStoreId={storeId} from={from} to={to} />

      {!active && (
        <div className="stub-note" style={{ marginBottom: 20 }}>
          ИИ-провайдер пока не настроен. {user.role === 'SUPER_ADMIN' ? (
            <>
              Подключите его в разделе <a href="/settings">«Настройки → ИИ»</a> — ключ хранится в зашифрованном виде и нигде не
              показывается повторно.
            </>
          ) : (
            'Обратитесь к главному администратору агентства.'
          )}{' '}
          Все финансовые расчёты уже работают независимо от ИИ — см. «Обзор», «Товары» и «Расходы».
        </div>
      )}

      <FreshnessBanner dataAsOf={ctx.dataAsOf} isStale={ctx.isStale} />

      <div className="panel">
        <h2>Спросить ИИ-аналитика</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -8, marginBottom: 14 }}>
          Аналитик объясняет уже посчитанные цифры дашборда за выбранный период и магазин — он ничего не считает сам и не видит
          ключи, пароли и платёжные данные.
        </p>

        <div className="chat-thread">
          {messages.length === 0 && <div className="empty-state">Пока нет вопросов по этому магазину — задайте первый ниже.</div>}
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role === 'user' ? 'user' : 'assistant'}`}>
              <div className="chat-meta">
                {m.role === 'user' ? m.userName ?? 'Вы' : 'ИИ-аналитик'} · {m.createdAt.toLocaleString('ru-RU')}
              </div>
              {m.content}
            </div>
          ))}
        </div>

        <form action={askAnalystAction} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="storeId" value={storeId ?? ''} />
          <input type="hidden" name="from" value={inputDate(from)} />
          <input type="hidden" name="to" value={inputDate(to)} />
          <textarea
            name="question"
            placeholder="Например: почему упала прибыль в этом месяце?"
            rows={2}
            required
            style={{ flex: 1, minWidth: 240 }}
          />
          <button className="btn btn-primary" type="submit">
            Спросить
          </button>
        </form>
      </div>

      <div className="panel">
        <h2>Рекомендации</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -8, marginBottom: 14 }}>
          Каждая рекомендация сохраняется с указанием, на каких цифрах она основана и на какой момент данные были актуальны —
          это история для проверки, а не разовый ответ в чате.
        </p>

        {recommendations.length === 0 ? (
          <div className="empty-state">Рекомендаций пока нет — сформируйте первую ниже.</div>
        ) : (
          recommendations.map((r) => (
            <div key={r.id} className="rec-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{r.problem}</div>
                <span className={`pill ${PRIORITY_PILL[r.priority] ?? 'warning'}`}>{PRIORITY_LABEL[r.priority] ?? r.priority}</span>
              </div>
              <div className="rec-row">
                <b>Где:</b> {r.scope}
              </div>
              <div className="rec-row">
                <b>Цифры:</b> {r.metrics}
              </div>
              <div className="rec-row">
                <b>Действие:</b> {r.action}
              </div>
              <div className="rec-row">
                <b>Ожидаемый эффект:</b> {r.expectedEffect ?? 'не обосновано цифрами — не приводится'}
              </div>
              <div className="rec-row">
                <b>Допущения:</b> {r.assumptions}
              </div>
              <div className="rec-row">
                <b>Основание:</b> {r.evidence}
                {r.evidenceHref && (
                  <>
                    {' '}
                    · <a href={r.evidenceHref}>посмотреть цифры</a>
                  </>
                )}
              </div>
              <div className="rec-row" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                Данные на {r.dataAsOf.toLocaleString('ru-RU')} · сформировано {r.createdAt.toLocaleString('ru-RU')}
                {r.createdByName ? ` · ${r.createdByName}` : ''}
              </div>
            </div>
          ))
        )}

        <form action={generateRecommendationAction} style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="storeId" value={storeId ?? ''} />
          <input type="hidden" name="from" value={inputDate(from)} />
          <input type="hidden" name="to" value={inputDate(to)} />
          <input type="text" name="focus" placeholder="Необязательно: на чём сфокусироваться" style={{ flex: 1, minWidth: 220 }} />
          <button className="btn btn-primary" type="submit">
            Сформировать рекомендацию
          </button>
        </form>
      </div>
    </div>
  );
}
