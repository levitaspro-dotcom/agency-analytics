import { NextRequest, NextResponse } from 'next/server';
import { requireUser } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/crypto';

/**
 * ВРЕМЕННЫЙ диагностический роут — не часть постоянного API приложения.
 *
 * Цель: проверить на реальных данных Ольги (без угадывания по документации),
 * действительно ли Ozon Seller API отдаёт баллы за скидки / эквайринг /
 * программы партнёров / доставку до места выдачи через методы, которые наш
 * основной синк сейчас НЕ вызывает: /v1/finance/mutual-settlement и
 * /v1/finance/accrual/by-day (оба существуют в официальном API, в отличие от
 * /v1/finance/accrual/postings, который мы используем и который эти категории
 * не отдаёт вовсе, — но не тестировались нами напрямую).
 *
 * Использование: GET /api/debug/ozon-finance?storeId=...&from=2026-09-01&to=2026-09-17
 * Удалить после того, как вопрос будет закрыт.
 */

const OZON_API_BASE = 'https://api-seller.ozon.ru';

async function ozonFetch(clientId: string, apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${OZON_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Client-Id': clientId, 'Api-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : text;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, json };
}

export async function GET(req: NextRequest) {
  await requireUser(); // просто требуем логин, без дополнительных проверок — временный роут

  const { searchParams } = new URL(req.url);
  const storeId = searchParams.get('storeId');
  const projectId = searchParams.get('projectId');
  const from = searchParams.get('from') || '2026-09-01';
  const to = searchParams.get('to') || '2026-09-17';

  if (!storeId && !projectId) {
    return NextResponse.json({ error: 'storeId или projectId обязателен' }, { status: 400 });
  }

  const store = storeId
    ? await prisma.store.findUnique({ where: { id: storeId } })
    : await prisma.store.findFirst({ where: { projectId: projectId!, ozonClientId: { not: null } } });
  if (!store || !store.ozonClientId || !store.ozonApiKeyEncrypted) {
    return NextResponse.json({ error: 'Магазин не найден или Ozon не подключён' }, { status: 404 });
  }

  const clientId = store.ozonClientId;
  const apiKey = decryptSecret(store.ozonApiKeyEncrypted);

  // date-only YYYY-MM-DD -> границы дня в UTC, как ожидает Ozon
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T23:59:59.999Z`;
  const [fromYear, fromMonth] = from.split('-').map(Number);
  const [toYear, toMonth] = to.split('-').map(Number);

  const results: Record<string, unknown> = {};

  // 1) /v1/finance/mutual-settlement — «Отчёт о взаиморасчётах», месячный,
  //    по описанию должен включать эквайринг/продвижение отдельными строками
  try {
    results.mutual_settlement = await ozonFetch(clientId, apiKey, '/v1/finance/mutual-settlement', {
      date: { year: fromYear, month: fromMonth },
    });
  } catch (e) {
    results.mutual_settlement = { error: (e as Error).message };
  }

  // 2) /v1/finance/accrual/by-day — официальная замена /v3/finance/transaction/list,
  //    агрегирует по дню, не привязан к конкретному отправлению
  try {
    results.accrual_by_day = await ozonFetch(clientId, apiKey, '/v1/finance/accrual/by-day', {
      date: from,
    });
  } catch (e) {
    results.accrual_by_day = { error: (e as Error).message };
  }

  // 3) /v2/finance/realization — «Отчёт о реализации товаров v2»
  try {
    results.realization_v2 = await ozonFetch(clientId, apiKey, '/v2/finance/realization', {
      year: fromYear,
      month: fromMonth,
    });
  } catch (e) {
    results.realization_v2 = { error: (e as Error).message };
  }

  return NextResponse.json({ storeId, from, to, results }, { status: 200 });
}
