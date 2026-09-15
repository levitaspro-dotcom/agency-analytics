import { NextRequest, NextResponse } from 'next/server';
import { requireUser, assertProjectAccess, ForbiddenError } from '@/lib/authz';
import { resolvePeriod, formatDate } from '@/lib/period';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<string, string> = {
  REVENUE: 'Выручка',
  OZON_FEE: 'Комиссия Ozon',
  COGS: 'Себестоимость',
  EXTERNAL_EXPENSE: 'Внешний расход',
  TAX: 'Налог',
};

function csvEscape(v: string) {
  if (/[",;\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** CSV-экспорт финансовых операций проекта за период — та же проверка доступа
 *  (assertProjectAccess), что и на остальных страницах: экспорт не обходит RBAC. */
export async function GET(req: NextRequest) {
  const user = await requireUser();
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId') || '';
  const storeId = searchParams.get('storeId') || undefined;
  if (!projectId) return NextResponse.json({ error: 'projectId обязателен' }, { status: 400 });

  try {
    await assertProjectAccess(user, projectId);
  } catch (e) {
    if (e instanceof ForbiddenError) return NextResponse.json({ error: 'Нет доступа к проекту' }, { status: 403 });
    throw e;
  }

  const { from, to } = resolvePeriod({
    from: searchParams.get('from') || undefined,
    to: searchParams.get('to') || undefined,
  });

  const rows = await prisma.financeTransaction.findMany({
    where: { projectId, ...(storeId ? { storeId } : {}), date: { gte: from, lte: to } },
    orderBy: { date: 'asc' },
    include: { store: true, product: true },
  });

  const header = ['Дата', 'Тип', 'Категория', 'Сумма', 'Магазин', 'Товар', 'Описание'];
  const lines = [header.join(';')];
  for (const r of rows) {
    lines.push(
      [
        formatDate(r.date),
        TYPE_LABEL[r.type] ?? r.type,
        r.category,
        String(Math.round(r.amount)),
        r.store?.name ?? '',
        r.product?.name ?? '',
        r.description ?? '',
      ]
        .map((v) => csvEscape(String(v)))
        .join(';'),
    );
  }
  // BOM в начале — чтобы Excel на Windows правильно определил кодировку кириллицы
  const csv = '﻿' + lines.join('\n');

  await prisma.activityLog.create({
    data: {
      actorId: user.id,
      actorName: user.name,
      action: 'report.exportCsv',
      targetType: 'Project',
      targetId: projectId,
      meta: { storeId: storeId ?? null, from: from.toISOString(), to: to.toISOString(), rows: rows.length },
    },
  });

  const filename = `report_${projectId}_${inputDateSafe(from)}_${inputDateSafe(to)}.csv`;
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

function inputDateSafe(d: Date) {
  return d.toISOString().slice(0, 10);
}
