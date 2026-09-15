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
  // к какому Product привязывать каждую строку (сопоставление по Ozon SKU).
  let productsResult: { ok: boolean; message: string; products: { sku: string; offerId: string; name: string; sellPrice: number }[] };
  try {
    productsResult = await fetchOzonProducts(creds);
  } catch (e) {
    productsResult = { ok: false, message: (e as Error).message, products: [] };
  }

  const productIdBySku = new Map<string, string>();
  let productsImported = 0;
  if (productsResult.ok) {
    for (const p of productsResult.products) {
      const existing = await prisma.product.findFirst({ where: { projectId: store.projectId, storeId: store.id, sku: p.sku } });
      if (existing) {
        // Себестоимость — поле, которое заполняет вручную Ольга/менеджер, синхронизация её никогда не трогает.
        await prisma.product.update({ where: { id: existing.id }, data: { name: p.name, sellPrice: p.sellPrice } });
        productIdBySku.set(p.sku, existing.id);
      } else {
        const created = await prisma.product.create({
          data: { projectId: store.projectId, storeId: store.id, sku: p.sku, name: p.name, sellPrice: p.sellPrice, costPrice: 0 },
        });
        productIdBySku.set(p.sku, created.id);
        productsImported += 1;
      }
    }
  }

  let syncResult: { ok: boolean; message: string; operations: OzonOperation[] };
  try {
    syncResult = await fetchOzonFinanceTransactions(creds, from, to);
  } catch (e) {
    syncResult = { ok: false, message: (e as Error).message, operations: [] };
  }

  let imported = 0;
  if (syncResult.ok) {
    const rows: {
      projectId: string;
      storeId: string;
      productId: string | null;
      type: 'REVENUE' | 'OZON_FEE';
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
      const productId = op.sku ? productIdBySku.get(op.sku) ?? null : null;

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
        <h2>Клиенты и проекты</h2>
        {visibleClients.length === 0 && <div className="empty-state">Проектов пока нет.</div>}
        {visibleClients.map((client) => (
          <div key={client.id} style={{ marginBottom: 20 }}>
            <h3>{client.name}</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Проект</th>
                  <th>Магазины</th>
                  <th>Команда</th>
                  {isAdmin && <th>Назначить</th>}
                </tr>
              </thead>
              <tbody>
                {client.projects.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.stores.map((s) => s.name).join(', ') || '—'}</td>
                    <td>
                      {p.assignments.length === 0
                        ? '—'
                        : p.assignments.map((a) => (
                            <div key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
                              <span>
                                {a.user.name} ({a.user.role === 'MANAGER' ? 'менеджер' : 'клиент'})
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
          <h2>Добавить клиента</h2>
          <form action={createClientAction} style={{ display: 'flex', gap: 8 }}>
            <input type="text" name="name" placeholder="Название клиента" required style={{ flex: 1 }} />
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
