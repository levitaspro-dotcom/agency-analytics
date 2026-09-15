import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser, isManagerOrAbove, assertProjectAccess } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { encryptSecret, decryptSecret, last4 } from '@/lib/crypto';
import { testOzonConnection, fetchOzonFinanceTransactions, fetchOzonProducts, type OzonOperation } from '@/lib/integrations/ozon';

export const dynamic = 'force-dynamic';

async function createClientAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const name = String(formData.get('name') || '').trim();
  if (!name) return;
  const client = await prisma.client.create({ data: { name } });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'client.create', targetType: 'Client', targetId: client.id, meta: { name } },
  });
  revalidatePath('/projects');
}

async function createProjectAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const clientId = String(formData.get('clientId') || '');
  const name = String(formData.get('name') || '').trim();
  if (!clientId || !name) return;
  const project = await prisma.project.create({ data: { clientId, name } });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'project.create', targetType: 'Project', targetId: project.id, meta: { name } },
  });
  revalidatePath('/projects');
}

async function updateProjectTaxRateAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (!isManagerOrAbove(user.role)) throw new Error('Недостаточно прав');
  const projectId = String(formData.get('projectId') || '');
  const taxRateRaw = String(formData.get('taxRatePercent') || '').replace(',', '.').trim();
  if (!projectId) return;
  await assertProjectAccess(user, projectId);
  const taxRatePercent = Number(taxRateRaw);
  if (!Number.isFinite(taxRatePercent) || taxRatePercent < 0 || taxRatePercent > 100) return;

  await prisma.project.update({ where: { id: projectId }, data: { taxRatePercent } });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'project.setTaxRate', targetType: 'Project', targetId: projectId, meta: { taxRatePercent } },
  });
  revalidatePath('/projects');
  revalidatePath('/dashboard');
  revalidatePath('/expenses');
  revalidatePath('/reports');
}

async function renameClientAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const clientId = String(formData.get('clientId') || '');
  const name = String(formData.get('name') || '').trim();
  if (!clientId || !name) return;
  await prisma.client.update({ where: { id: clientId }, data: { name } });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'client.rename', targetType: 'Client', targetId: clientId, meta: { name } },
  });
  revalidatePath('/projects');
  revalidatePath('/agency');
}

async function deleteClientAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const clientId = String(formData.get('clientId') || '');
  if (!clientId) return;
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
  const projects = await prisma.project.findMany({ where: { clientId }, select: { id: true } });
  const projectIds = projects.map((p) => p.id);

  // Удаление продавца необратимо и удаляет вместе с ним все его проекты и всё, что было
  // загружено по ним (магазины, товары, финансовые операции) — как и при удалении
  // отдельного проекта или магазина, чтобы не оставалось «осиротевших» данных.
  await prisma.$transaction([
    prisma.financeTransaction.deleteMany({ where: { projectId: { in: projectIds } } }),
    prisma.product.deleteMany({ where: { projectId: { in: projectIds } } }),
    prisma.store.deleteMany({ where: { projectId: { in: projectIds } } }),
    prisma.project.deleteMany({ where: { clientId } }),
    prisma.client.delete({ where: { id: clientId } }),
  ]);

  await prisma.activityLog.create({
    data: {
      actorId: user.id,
      actorName: user.name,
      action: 'client.delete',
      targetType: 'Client',
      targetId: clientId,
      meta: { name: client.name, projectsDeleted: projectIds.length },
    },
  });
  revalidatePath('/projects');
  revalidatePath('/agency');
  revalidatePath('/dashboard');
}

async function renameProjectAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const projectId = String(formData.get('projectId') || '');
  const name = String(formData.get('name') || '').trim();
  if (!projectId || !name) return;
  await prisma.project.update({ where: { id: projectId }, data: { name } });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'project.rename', targetType: 'Project', targetId: projectId, meta: { name } },
  });
  revalidatePath('/projects');
  revalidatePath('/agency');
}

async function deleteProjectAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const projectId = String(formData.get('projectId') || '');
  if (!projectId) return;
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  // Как и удаление магазина/продавца — необратимо: вместе с проектом удаляются все его
  // магазины, товары и финансовые операции, чтобы не оставалось «осиротевших» данных.
  // Назначения пользователей, сообщения ИИ-аналитика и рекомендации по проекту удаляются
  // автоматически на уровне базы (каскад по внешнему ключу).
  await prisma.$transaction([
    prisma.financeTransaction.deleteMany({ where: { projectId } }),
    prisma.product.deleteMany({ where: { projectId } }),
    prisma.store.deleteMany({ where: { projectId } }),
    prisma.project.delete({ where: { id: projectId } }),
  ]);

  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'project.delete', targetType: 'Project', targetId: projectId, meta: { name: project.name } },
  });
  revalidatePath('/projects');
  revalidatePath('/agency');
  revalidatePath('/dashboard');
}

async function assignUserAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const projectId = String(formData.get('projectId') || '');
  const userId = String(formData.get('userId') || '');
  if (!projectId || !userId) return;
  await prisma.projectAssignment.upsert({
    where: { projectId_userId: { projectId, userId } },
    update: {},
    create: { projectId, userId },
  });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'assignment.create', targetType: 'Project', targetId: projectId, meta: { userId } },
  });
  revalidatePath('/projects');
}

async function removeAssignmentAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const id = String(formData.get('assignmentId') || '');
  if (!id) return;
  const a = await prisma.projectAssignment.delete({ where: { id } });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'assignment.remove', targetType: 'Project', targetId: a.projectId, meta: { userId: a.userId } },
  });
  revalidatePath('/projects');
}

async function addStoreAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (!isManagerOrAbove(user.role)) throw new Error('Недостаточно прав');
  const projectId = String(formData.get('projectId') || '');
  const name = String(formData.get('name') || '').trim();
  const ozonClientId = String(formData.get('ozonClientId') || '').trim();
  const ozonApiKey = String(formData.get('ozonApiKey') || '').trim();
  if (!projectId || !name) return;
  await assertProjectAccess(user, projectId);

  const store = await prisma.store.create({
    data: {
      projectId,
      name,
      ozonClientId: ozonClientId || null,
      ozonApiKeyEncrypted: ozonApiKey ? encryptSecret(ozonApiKey) : null,
      ozonApiKeyLast4: ozonApiKey ? last4(ozonApiKey) : null,
    },
  });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'store.create', targetType: 'Store', targetId: store.id, meta: { name, projectId } },
  });
  revalidatePath('/projects');
}

async function testStoreConnectionAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (!isManagerOrAbove(user.role)) throw new Error('Недостаточно прав');
  const storeId = String(formData.get('storeId') || '');
  if (!storeId) return;
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  await assertProjectAccess(user, store.projectId);

  let result: { ok: boolean; message: string };
  if (!store.ozonClientId || !store.ozonApiKeyEncrypted) {
    result = { ok: false, message: 'Сначала укажите Client-Id и Api-Key.' };
  } else {
    try {
      result = await testOzonConnection({ clientId: store.ozonClientId, apiKey: decryptSecret(store.ozonApiKeyEncrypted) });
    } catch (e) {
      result = { ok: false, message: (e as Error).message };
    }
  }

  await prisma.store.update({
    where: { id: storeId },
    data: { lastTestAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message },
  });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'store.testConnection', targetType: 'Store', targetId: storeId, meta: result },
  });
  revalidatePath('/projects');
}

async function syncStoreAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (!isManagerOrAbove(user.role)) throw new Error('Недостаточно прав');
  const storeId = String(formData.get('storeId') || '');
  const days = Math.min(60, Math.max(1, Number(formData.get('days') || 30)));
  if (!storeId) return;
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  await assertProjectAccess(user, store.projectId);

  if (!store.ozonClientId || !store.ozonApiKeyEncrypted) {
    await prisma.store.update({
      where: { id: storeId },
      data: { lastSyncAt: new Date(), lastSyncOk: false, lastSyncMessage: 'Сначала укажите Client-Id и Api-Key.' },
    });
    revalidatePath('/projects');
    return;
  }

  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const creds = { clientId: store.ozonClientId, apiKey: decryptSecret(store.ozonApiKeyEncrypted) };

  // Сначала каталог товаров — чтобы при сохранении финансовых операций сразу знать,
  // к какому Product привязывать каждую строку. Сопоставляем по артикулу продавца
  // (offer_id) — он стабилен между синхронизациями, в отличие от числового SKU Ozon,
  // который иногда не отдаётся сразу или отличается для FBO/FBS одного и того же товара.
  let productsResult: {
    ok: boolean;
    message: string;
    products: { sku: string; skuAliases: string[]; offerId: string; name: string; sellPrice: number }[];
  };
  try {
    productsResult = await fetchOzonProducts(creds);
  } catch (e) {
    productsResult = { ok: false, message: (e as Error).message, products: [] };
  }

  // Ключ — любой известный алиас SKU (обычный/FBO/FBS) → id канонической записи Product.
  // Финансовые операции Ozon могут прийти с любым из вариантов, поэтому привязываем по всем сразу.
  type PRow = { id: string; offerId: string | null; costPrice: number };
  const productIdByAliasSku = new Map<string, string>();
  let productsImported = 0;
  if (productsResult.ok) {
    const existingByOfferId = (await prisma.product.findMany({
      where: { projectId: store.projectId, storeId: store.id, offerId: { not: null } },
    })) as PRow[];
    const existingByOfferIdMap = new Map<string, PRow>();
    for (const row of existingByOfferId) if (row.offerId) existingByOfferIdMap.set(row.offerId, row);

    for (const p of productsResult.products) {
      // 1) сначала ищем по offer_id — это стабильный ключ, синхронизация его не путает.
      let canonical: PRow | null = existingByOfferIdMap.get(p.offerId) ?? null;

      // 2) если по offer_id ничего нет — ищем среди старых записей (созданных ещё до
      // появления offerId, по нестабильному числовому sku) по любому известному алиасу —
      // это как раз «осиротевшие» дубликаты из прошлых синхронизаций.
      if (!canonical && p.skuAliases.length > 0) {
        canonical = (await prisma.product.findFirst({
          where: { projectId: store.projectId, storeId: store.id, sku: { in: p.skuAliases } },
        })) as PRow | null;
      }

      if (canonical) {
        // Себестоимость — поле, которое заполняет вручную Ольга/менеджер, синхронизация
        // её никогда не трогает и не перезаписывает.
        canonical = (await prisma.product.update({
          where: { id: canonical.id },
          data: { name: p.name, sellPrice: p.sellPrice, sku: p.sku, offerId: p.offerId },
        })) as PRow;
      } else {
        canonical = (await prisma.product.create({
          data: { projectId: store.projectId, storeId: store.id, sku: p.sku, offerId: p.offerId, name: p.name, sellPrice: p.sellPrice, costPrice: 0 },
        })) as PRow;
        productsImported += 1;
      }

      const canonicalId: string = canonical.id;
      for (const alias of p.skuAliases) productIdByAliasSku.set(alias, canonicalId);
      productIdByAliasSku.set(p.sku, canonicalId);

      // 3) любые другие записи того же товара (дубликаты, накопившиеся в прошлых
      // синхронизациях под другим алиасом SKU до перехода на offer_id) — сливаем в
      // каноническую: переносим уже введённую вручную себестоимость (если в канонической
      // её ещё нет) и переносим на неё финансовые операции, сами дубликаты удаляем, чтобы
      // не плодить «мёртвые» карточки товаров и не терять привязку операций к товару.
      const duplicates = (await prisma.product.findMany({
        where: {
          projectId: store.projectId,
          storeId: store.id,
          id: { not: canonicalId },
          OR: [{ sku: { in: p.skuAliases.length > 0 ? p.skuAliases : [p.sku] } }, { offerId: p.offerId }],
        },
      })) as PRow[];
      if (duplicates.length > 0) {
        const recoveredCostPrice = duplicates.find((d) => d.costPrice > 0)?.costPrice;
        if (canonical.costPrice <= 0 && recoveredCostPrice) {
          canonical = (await prisma.product.update({ where: { id: canonicalId }, data: { costPrice: recoveredCostPrice } })) as PRow;
        }
        await prisma.financeTransaction.updateMany({
          where: { productId: { in: duplicates.map((d) => d.id) } },
          data: { productId: canonicalId },
        });
        await prisma.product.deleteMany({ where: { id: { in: duplicates.map((d) => d.id) } } });
      }
    }
  }

  let syncResult: { ok: boolean; message: string; operations: OzonOperation[] };
  try {
    syncResult = await fetchOzonFinanceTransactions(creds, from, to);
  } catch (e) {
    syncResult = { ok: false, message: (e as Error).message, operations: [] };
  }

  // Себестоимость проданного Ozon не знает и не присылает — считаем сами:
  // quantity (из строки начисления) × Product.costPrice (введена вручную).
  // Берём актуальные цены уже после слияния дубликатов выше.
  const productCostPriceById = new Map<string, number>();
  {
    const productIds = Array.from(new Set(productIdByAliasSku.values()));
    if (productIds.length > 0) {
      const rows = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, costPrice: true } });
      for (const r of rows) productCostPriceById.set(r.id, r.costPrice);
    }
  }

  let imported = 0;
  if (syncResult.ok) {
    const rows: {
      projectId: string;
      storeId: string;
      productId: string | null;
      type: 'REVENUE' | 'OZON_FEE' | 'COGS';
      category: string;
      amount: number;
      date: Date;
      externalId: string;
    }[] = [];

    for (const op of syncResult.operations) {
      const date = new Date(op.operation_date);
      const accrual = op.accruals_for_sale || 0;
      const net = op.amount || 0;
      const fee = accrual - net;
      const productId = op.sku ? productIdByAliasSku.get(op.sku) ?? null : null;

      if (accrual > 0) {
        rows.push({
          projectId: store.projectId,
          storeId: store.id,
          productId,
          type: 'REVENUE',
          category: 'Продажи Ozon',
          amount: accrual,
          date,
          externalId: `${op.operation_id}:revenue`,
        });

        // Строка начисления с положительной суммой и известным количеством — это
        // продажа единиц товара: если себестоимость для товара введена, сразу же
        // признаём её расходом за тот же период, что и выручку по этой же продаже.
        const costPrice = productId ? productCostPriceById.get(productId) : undefined;
        if (productId && costPrice && costPrice > 0 && op.quantity && op.quantity > 0) {
          rows.push({
            projectId: store.projectId,
            storeId: store.id,
            productId,
            type: 'COGS',
            category: 'Себестоимость проданных товаров',
            amount: costPrice * op.quantity,
            date,
            externalId: `${op.operation_id}:cogs`,
          });
        }
      }
      if (fee > 0) {
        rows.push({
          projectId: store.projectId,
          storeId: store.id,
          productId,
          type: 'OZON_FEE',
          category: op.operation_type_name || 'Комиссия Ozon',
          amount: fee,
          date,
          externalId: `${op.operation_id}:fee`,
        });
      } else if (accrual === 0 && net < 0) {
        rows.push({
          projectId: store.projectId,
          storeId: store.id,
          productId,
          type: 'OZON_FEE',
          category: op.operation_type_name || 'Комиссия Ozon',
          amount: Math.abs(net),
          date,
          externalId: `${op.operation_id}:fee`,
        });
      } else if (accrual === 0 && net > 0) {
        rows.push({
          projectId: store.projectId,
          storeId: store.id,
          productId,
          type: 'REVENUE',
          category: op.operation_type_name || 'Прочие начисления Ozon',
          amount: net,
          date,
          externalId: `${op.operation_id}:revenue`,
        });
      }
    }

    if (rows.length > 0) {
      const created = await prisma.financeTransaction.createMany({ data: rows, skipDuplicates: true });
      imported = created.count;
    }
  }

  const parts = [
    productsResult.ok ? `товаров: ${productsResult.products.length} (новых: ${productsImported})` : `товары — ошибка: ${productsResult.message}`,
    syncResult.ok ? `${syncResult.message} · новых операций сохранено: ${imported}` : `операции — ошибка: ${syncResult.message}`,
  ];
  const overallOk = productsResult.ok && syncResult.ok;

  await prisma.store.update({
    where: { id: storeId },
    data: {
      lastSyncAt: new Date(),
      lastSyncOk: overallOk,
      lastSyncMessage: parts.join(' · '),
      lastSyncCount: imported,
    },
  });
  await prisma.activityLog.create({
    data: {
      actorId: user.id,
      actorName: user.name,
      action: 'store.sync',
      targetType: 'Store',
      targetId: storeId,
      meta: { ok: overallOk, imported, productsImported, days },
    },
  });
  revalidatePath('/projects');
  revalidatePath('/dashboard');
  revalidatePath('/expenses');
  revalidatePath('/products');
}

export async function updateProductCostAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (!isManagerOrAbove(user.role)) throw new Error('Недостаточно прав');
  const productId = String(formData.get('productId') || '');
  const costPriceRaw = String(formData.get('costPrice') || '').replace(',', '.').trim();
  if (!productId) return;
  const costPrice = Number(costPriceRaw);
  if (!Number.isFinite(costPrice) || costPrice < 0) return;

  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  await assertProjectAccess(user, product.projectId);

  await prisma.product.update({ where: { id: productId }, data: { costPrice } });
  await prisma.activityLog.create({
    data: {
      actorId: user.id,
      actorName: user.name,
      action: 'product.setCostPrice',
      targetType: 'Product',
      targetId: productId,
      meta: { sku: product.sku, costPrice },
    },
  });
  revalidatePath('/products');
}

async function deleteStoreAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (!isManagerOrAbove(user.role)) throw new Error('Недостаточно прав');
  const storeId = String(formData.get('storeId') || '');
  if (!storeId) return;
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  await assertProjectAccess(user, store.projectId);

  // Магазин удаляется вместе со всеми данными, которые были привязаны именно к нему
  // (импортированные из Ozon финансовые операции и карточки товаров этого магазина),
  // чтобы после удаления в дашборде не осталось «осиротевших» цифр.
  await prisma.$transaction([
    prisma.financeTransaction.deleteMany({ where: { storeId } }),
    prisma.product.deleteMany({ where: { storeId } }),
    prisma.store.delete({ where: { id: storeId } }),
  ]);

  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'store.delete', targetType: 'Store', targetId: storeId, meta: { name: store.name, projectId: store.projectId } },
  });
  revalidatePath('/projects');
  revalidatePath('/dashboard');
  revalidatePath('/expenses');
  revalidatePath('/products');
}

export default async function ProjectsPage() {
  const user = await requireUser();
  if (!isManagerOrAbove(user.role)) redirect('/dashboard');
  const isAdmin = user.role === 'SUPER_ADMIN';

  const clients = await prisma.client.findMany({
    include: { projects: { include: { stores: true, assignments: { include: { user: true } } } } },
    orderBy: { createdAt: 'asc' },
  });

  const visibleClients = isAdmin
    ? clients
    : clients
        .map((c) => ({ ...c, projects: c.projects.filter((p) => p.assignments.some((a) => a.userId === user.id)) }))
        .filter((c) => c.projects.length > 0);

  const allUsers = isAdmin ? await prisma.user.findMany({ orderBy: { name: 'asc' } }) : [];

  return (
    <div>
      <div className="panel">
        <h2>Продавцы и проекты</h2>
        {visibleClients.length === 0 && <div className="empty-state">Проектов пока нет.</div>}
        {visibleClients.map((client) => (
          <div key={client.id} style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
              {isAdmin ? (
                <form action={renameClientAction} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input type="hidden" name="clientId" value={client.id} />
                  <input
                    type="text"
                    name="name"
                    defaultValue={client.name}
                    style={{ fontSize: 15, fontWeight: 600, padding: '3px 6px', width: 200 }}
                  />
                  <button className="btn" style={{ padding: '3px 8px', fontSize: 12 }} type="submit">
                    ✓
                  </button>
                </form>
              ) : (
                <h3 style={{ margin: 0 }}>{client.name}</h3>
              )}
              {isAdmin && (
                <form action={deleteClientAction}>
                  <input type="hidden" name="clientId" value={client.id} />
                  <button className="btn btn-danger" style={{ padding: '3px 8px', fontSize: 12 }} type="submit">
                    Удалить продавца
                  </button>
                </form>
              )}
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Проект</th>
                  <th>Магазины</th>
                  <th className="tooltip-hint" title="Ставка налога от выручки (например 6 для УСН «Доходы» 6%) — задаётся вручную, Ozon её не знает и не присылает">
                    Налог, %
                  </th>
                  <th>Команда</th>
                  {isAdmin && <th>Назначить</th>}
                  {isAdmin && <th>Действия</th>}
                </tr>
              </thead>
              <tbody>
                {client.projects.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.stores.map((s) => s.name).join(', ') || '—'}</td>
                    <td>
                      <form action={updateProjectTaxRateAction} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input type="hidden" name="projectId" value={p.id} />
                        <input
                          type="text"
                          name="taxRatePercent"
                          defaultValue={p.taxRatePercent > 0 ? p.taxRatePercent : ''}
                          placeholder="0"
                          style={{ width: 52, padding: '4px 6px', fontSize: 12.5 }}
                        />
                        <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                          ✓
                        </button>
                      </form>
                    </td>
                    <td>
                      {p.assignments.length === 0
                        ? '—'
                        : p.assignments.map((a) => (
                            <div key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                              <span>
                                {a.user.name} ({a.user.role === 'MANAGER' ? 'менеджер' : 'продавец'})
                              </span>
                              {isAdmin && (
                                <form action={removeAssignmentAction}>
                                  <input type="hidden" name="assignmentId" value={a.id} />
                                  <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }}>
                                    убрать
                                  </button>
                                </form>
                              )}
                            </div>
                          ))}
                    </td>
                    {isAdmin && (
                      <td>
                        <form action={assignUserAction} style={{ display: 'flex', gap: 6 }}>
                          <input type="hidden" name="projectId" value={p.id} />
                          <select name="userId" style={{ fontSize: 12, padding: '4px 6px' }}>
                            {allUsers
                              .filter((u) => u.role !== 'SUPER_ADMIN')
                              .map((u) => (
                                <option key={u.id} value={u.id}>
                                  {u.name}
                                </option>
                              ))}
                          </select>
                          <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }}>
                            Назначить
                          </button>
                        </form>
                      </td>
                    )}
                    {isAdmin && (
                      <td>
                        <form action={renameProjectAction} style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                          <input type="hidden" name="projectId" value={p.id} />
                          <input
                            type="text"
                            name="name"
                            defaultValue={p.name}
                            style={{ width: 110, padding: '4px 6px', fontSize: 12.5 }}
                          />
                          <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                            ✓
                          </button>
                        </form>
                        <form action={deleteProjectAction}>
                          <input type="hidden" name="projectId" value={p.id} />
                          <button className="btn btn-danger" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                            Удалить
                          </button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>Магазины Ozon</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -8, marginBottom: 14 }}>
          Client-Id и Api-Key берутся в личном кабинете Ozon Seller: Настройки → Seller API. Ключ хранится на
          сервере в зашифрованном виде и повторно нигде не показывается — только последние 4 символа, чтобы
          понять, какой ключ сохранён. Удаление магазина необратимо и удаляет вместе с ним все загруженные из
          Ozon финансовые операции и товары этого магазина.
        </p>

        {visibleClients.flatMap((c) => c.projects).every((p) => p.stores.length === 0) && (
          <div className="empty-state">Магазинов пока нет — добавьте первый ниже.</div>
        )}

        {visibleClients.map((client) =>
          client.projects
            .filter((p) => p.stores.length > 0)
            .map((p) => (
              <div key={p.id} style={{ marginBottom: 18 }}>
                <h3>
                  {client.name} · {p.name}
                </h3>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Магазин</th>
                      <th>Client-Id</th>
                      <th>Api-Key</th>
                      <th>Проверка подключения</th>
                      <th>Синхронизация за 30 дней</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.stores.map((s) => (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>{s.ozonClientId || '—'}</td>
                        <td>{s.ozonApiKeyLast4 ? `••••${s.ozonApiKeyLast4}` : '—'}</td>
                        <td>
                          <div style={{ marginBottom: 6 }}>
                            {s.lastTestAt ? (
                              <span className={`pill ${s.lastTestOk ? 'ok' : 'critical'}`}>{s.lastTestOk ? 'Подключено' : 'Ошибка'}</span>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>ещё не проверялось</span>
                            )}
                            {s.lastTestMessage && (
                              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{s.lastTestMessage}</div>
                            )}
                          </div>
                          <form action={testStoreConnectionAction}>
                            <input type="hidden" name="storeId" value={s.id} />
                            <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                              Проверить
                            </button>
                          </form>
                        </td>
                        <td>
                          <div style={{ marginBottom: 6 }}>
                            {s.lastSyncAt ? (
                              <span className={`pill ${s.lastSyncOk ? 'ok' : 'critical'}`}>{s.lastSyncOk ? 'Успешно' : 'Ошибка'}</span>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>ещё не запускалась</span>
                            )}
                            {s.lastSyncMessage && (
                              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{s.lastSyncMessage}</div>
                            )}
                          </div>
                          <form action={syncStoreAction}>
                            <input type="hidden" name="storeId" value={s.id} />
                            <input type="hidden" name="days" value={30} />
                            <button className="btn btn-primary" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                              Синхронизировать
                            </button>
                          </form>
                        </td>
                        <td>
                          <form action={deleteStoreAction}>
                            <input type="hidden" name="storeId" value={s.id} />
                            <button className="btn btn-danger" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                              Удалить
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )),
        )}

        <h3>Добавить магазин</h3>
        <form action={addStoreAction} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select name="projectId">
            {visibleClients.flatMap((c) =>
              c.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {c.name} · {p.name}
                </option>
              )),
            )}
          </select>
          <input type="text" name="name" placeholder="Название магазина" required />
          <input type="text" name="ozonClientId" placeholder="Ozon Client-Id" />
          <input type="password" name="ozonApiKey" placeholder="Ozon Api-Key" autoComplete="off" />
          <button className="btn btn-primary" type="submit">
            Добавить
          </button>
        </form>
      </div>

      {isAdmin && (
        <div className="panel">
          <h2>Добавить продавца</h2>
          <form action={createClientAction} style={{ display: 'flex', gap: 8 }}>
            <input type="text" name="name" placeholder="Название продавца" required style={{ flex: 1 }} />
            <button className="btn btn-primary" type="submit">
              Создать
            </button>
          </form>
        </div>
      )}

      {isAdmin && (
        <div className="panel">
          <h2>Добавить проект</h2>
          <form action={createProjectAction} style={{ display: 'flex', gap: 8 }}>
            <select name="clientId">
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input type="text" name="name" placeholder="Название проекта" required style={{ flex: 1 }} />
            <button className="btn btn-primary" type="submit">
              Создать
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
