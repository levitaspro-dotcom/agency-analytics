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
 * основной синк сейчас НЕ вызывает.
 *
 * v2 этого роута: /v1/finance/accrual/by-day уже подтверждён рабочим (200,
 * реальные NON_ITEM-начисления, не привязанные к отправлению) — теперь
 * прогоняем весь период по дням и расшифровываем type_id через
 * /v1/finance/accrual/types. Также чиним формат запроса mutual-settlement.
 *
 * Использование: GET /api/debug/ozon-finance?projectId=...&from=2026-09-01&to=2026-09-17
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

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function fetchAccrualTypeNames(
  clientId: string,
  apiKey: string,
): Promise<{ map: Map<number, string>; raw: unknown }> {
  const map = new Map<number, string>();
  let raw: unknown = null;
  try {
    const { ok, json } = await ozonFetch(clientId, apiKey, '/v1/finance/accrual/types', { language: 'RU' });
    raw = json;
    if (!ok) return { map, raw };
    const list =
      (Array.isArray(json?.result) && json.result) ||
      (Array.isArray(json?.result?.types) && json.result.types) ||
      (Array.isArray(json?.types) && json.types) ||
      (Array.isArray(json) && json) ||
      [];
    for (const item of list) {
      const id = item?.type_id ?? item?.id;
      const name = item?.name ?? item?.title ?? item?.type_name;
      if (id !== undefined && name) map.set(Number(id), String(name));
    }
  } catch {
    // тихо игнорируем — это диагностика, не критично
  }
  return { map, raw };
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

  const [fromYear, fromMonth] = from.split('-').map(Number);
  const results: Record<string, unknown> = {};

  const { map: typeNames, raw: typeNamesRaw } = await fetchAccrualTypeNames(clientId, apiKey);

  // 1) /v1/finance/accrual/by-day по каждому дню периода — собираем все
  //    начисления, отдельно отмечаем NON_ITEM (не привязанные к отправлению)
  const allAccruals: any[] = [];
  const byDayErrors: Record<string, unknown> = {};
  for (const day of dateRange(from, to)) {
    const { ok, status, json } = await ozonFetch(clientId, apiKey, '/v1/finance/accrual/by-day', { date: day });
    if (ok && Array.isArray(json?.accruals)) {
      allAccruals.push(...json.accruals);
    } else if (!ok) {
      byDayErrors[day] = { status, json };
    }
  }
  const nonItem = allAccruals.filter((a) => a?.accrued_category === 'NON_ITEM');
  const nonItemByType = new Map<number, { count: number; total: number; sample: any }>();
  for (const a of nonItem) {
    const typeId = Number(a?.non_item_fee?.type_id ?? a?.item_fees?.[0]?.type_id ?? -1);
    const amount = Number(a?.total_amount?.amount ?? 0);
    const entry = nonItemByType.get(typeId) ?? { count: 0, total: 0, sample: a };
    entry.count += 1;
    entry.total += amount;
    nonItemByType.set(typeId, entry);
  }
  results.accrual_by_day = {
    totalDays: dateRange(from, to).length,
    totalAccruals: allAccruals.length,
    totalNonItem: nonItem.length,
    errors: Object.keys(byDayErrors).length ? byDayErrors : undefined,
    nonItemByType: Array.from(nonItemByType.entries()).map(([typeId, v]) => ({
      typeId,
      typeName: typeNames.get(typeId) ?? null,
      count: v.count,
      total: Math.round(v.total * 100) / 100,
      sample: v.sample,
    })),
    typeNamesRawSample: typeNames.size === 0 ? typeNamesRaw : undefined,
  };

  // 2) /v1/finance/mutual-settlement — формат "date": "YYYY-MM" подтверждён (regex
  //    прошёл), но за текущий месяц документа ещё нет (404 "finance document not
  //    found") — пробуем и текущий, и предыдущий ЗАВЕРШЁННЫЙ месяц.
  const dateStr = `${fromYear}-${String(fromMonth).padStart(2, '0')}`;
  const prevMonthDate0 = new Date(Date.UTC(fromYear, fromMonth - 2, 1)); // fromMonth is 1-based
  const prevDateStr = `${prevMonthDate0.getUTCFullYear()}-${String(prevMonthDate0.getUTCMonth() + 1).padStart(2, '0')}`;
  try {
    results.mutual_settlement_current = await ozonFetch(clientId, apiKey, '/v1/finance/mutual-settlement', {
      date: dateStr,
    });
  } catch (e) {
    results.mutual_settlement_current = { error: (e as Error).message };
  }
  try {
    results.mutual_settlement_prev = await ozonFetch(clientId, apiKey, '/v1/finance/mutual-settlement', {
      date: prevDateStr,
    });
  } catch (e) {
    results.mutual_settlement_prev = { error: (e as Error).message };
  }

  // 3) /v2/finance/realization за прошлый ЗАВЕРШЁННЫЙ месяц (текущий может быть
  //    ещё не закрыт, отсюда "Report was not found" при первой попытке). Сворачиваем
  //    построчную разбивку в суммы по полям — интересуют bank_coinvestment (похоже на
  //    эквайринг) и pick_up_point_coinvestment (похоже на доставку до места выдачи).
  //    ВАЖНО: реальные ключи JSON — латиницей (проверено по firstRow предыдущего
  //    прогона), а не кириллицей, как в переводе документации — используем настоящие.
  try {
    const { ok, status, json } = await ozonFetch(clientId, apiKey, '/v2/finance/realization', {
      year: prevMonthDate0.getUTCFullYear(),
      month: prevMonthDate0.getUTCMonth() + 1,
    });
    if (ok && Array.isArray(json?.result?.rows)) {
      const rows: any[] = json.result.rows;
      const sums: Record<string, number> = {};
      const addSum = (key: string, value: unknown) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n === 0) return;
        sums[key] = Math.round(((sums[key] ?? 0) + n) * 100) / 100;
      };
      for (const row of rows) {
        const dc = row?.delivery_commission ?? {};
        for (const key of [
          'amount',
          'compensation',
          'commission',
          'bonus',
          'standard_fee',
          'total',
          'stars',
          'bank_coinvestment',
          'pick_up_point_coinvestment',
        ]) {
          addSum(`delivery_commission.${key}`, dc?.[key]);
        }
        if (row?.return_commission && typeof row.return_commission === 'object') {
          for (const [k, v] of Object.entries(row.return_commission)) addSum(`return_commission.${k}`, v);
        }
      }
      results.realization_v2_prev_month = {
        status,
        rowCount: rows.length,
        header: json.result.header,
        fieldSums: sums,
      };
    } else {
      results.realization_v2_prev_month = { status, ok, json };
    }
  } catch (e) {
    results.realization_v2_prev_month = { error: (e as Error).message };
  }

  return NextResponse.json({ storeId: store.id, from, to, results }, { status: 200 });
}
