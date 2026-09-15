import { prisma } from './prisma';

const STALE_AFTER_HOURS = 72;

export interface DataFreshness {
  dataAsOf: Date | null;
  isStale: boolean;
}

/** Единая логика "признака устаревания данных" — используется и ИИ-аналитиком (чтобы
 *  предупредить в ответе), и обычными страницами (чтобы показать баннер пользователю).
 *  "Устарело" = за последние 72 часа не было ни новой синхронизации Ozon, ни финансовых
 *  операций по проекту (или магазину, если он выбран). */
export async function getProjectDataFreshness(projectId: string, storeId?: string): Promise<DataFreshness> {
  const [lastTx, lastSync] = await Promise.all([
    prisma.financeTransaction.findFirst({
      where: { projectId, ...(storeId ? { storeId } : {}) },
      orderBy: { date: 'desc' },
      select: { date: true },
    }),
    prisma.store.findFirst({
      where: { projectId, ...(storeId ? { id: storeId } : {}), lastSyncAt: { not: null } },
      orderBy: { lastSyncAt: 'desc' },
      select: { lastSyncAt: true },
    }),
  ]);

  const candidates = [lastTx?.date, lastSync?.lastSyncAt].filter((d): d is Date => !!d);
  const dataAsOf = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
  const isStale = !dataAsOf || (Date.now() - dataAsOf.getTime()) / 3600000 > STALE_AFTER_HOURS;

  return { dataAsOf, isStale };
}
