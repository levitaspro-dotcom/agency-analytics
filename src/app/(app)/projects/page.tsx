import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { requireUser, isManagerOrAbove, assertProjectAccess } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { encryptSecret, decryptSecret, last4 } from '@/lib/crypto';
import { issueInvite } from '@/lib/invite';
import {
  testOzonConnection,
  fetchOzonFinanceTransactions,
  fetchOzonProducts,
  fetchRealizationReport,
  type OzonOperation,
  type OzonPostingProductLine,
} from '@/lib/integrations/ozon';

export const dynamic = 'force-dynamic';

const MARKETPLACE_LABEL: Record<string, string> = {
  OZON: 'Ozon',
  WILDBERRIES: 'Wildberries',
};

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

// Даёт продавцу доступ (логин): создаёт пользователя с ролью «Продавец», привязанного к этому
// продавцу, и отправляет ему письмо-приглашение — то же самое, что «Добавить пользователя» в
// Настройках, но прямо в карточке продавца и сразу с привязкой, без похода в другой раздел.
async function grantAccessAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const clientId = String(formData.get('clientId') || '');
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const name = String(formData.get('name') || '').trim();
  if (!clientId || !email || !name) return;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    redirect(`/projects?accessError=${encodeURIComponent('Пользователь с таким email уже есть.')}`);
  }

  // Пароль никто не вводит и не видит — случайная строка только для того, чтобы поле было
  // непустым. Войти можно только через ссылку из письма, где пользователь сам задаёт пароль.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  const newUser = await prisma.user.create({ data: { email, name, role: 'CLIENT', clientId, passwordHash } });
  await prisma.activityLog.create({
    data: { actorId: admin.id, actorName: admin.name, action: 'user.create', targetType: 'User', targetId: email, meta: { role: 'CLIENT', name, clientId } },
  });

  const { link, result } = await issueInvite(newUser.id, email, name);
  await prisma.activityLog.create({
    data: {
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.invite',
      targetType: 'User',
      targetId: newUser.id,
      meta: { email, emailSent: result.ok, emailMessage: result.message },
    },
  });
  revalidatePath('/projects');
  revalidatePath('/settings');
  if (!result.ok) {
    redirect(`/projects?accessLink=${encodeURIComponent(link)}&accessEmail=${encodeURIComponent(email)}`);
  }
}

async function resendAccessAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const userId = String(formData.get('userId') || '');
  if (!userId) return;
  const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (target.inviteAcceptedAt) return;

  const { link, result } = await issueInvite(target.id, target.email, target.name);
  await prisma.activityLog.create({
    data: {
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.reinvite',
      targetType: 'User',
      targetId: userId,
      meta: { email: target.email, emailSent: result.ok, emailMessage: result.message },
    },
  });
  revalidatePath('/projects');
  if (!result.ok) {
    redirect(`/projects?accessLink=${encodeURIComponent(link)}&accessEmail=${encodeURIComponent(target.email)}`);
  }
}

// Удаляет один логин продавца (не самого продавца). При удалении продавца целиком все его
// логины удаляются автоматически вместе с ним — см. deleteClientAction.
async function removeAccessAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const userId = String(formData.get('userId') || '');
  if (!userId) return;
  const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  await prisma.$transaction([
    prisma.projectAssignment.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);
  await prisma.activityLog.create({
    data: {
      actorId: admin.id,
      actorName: admin.name,
      action: 'user.delete',
      targetType: 'User',
      targetId: userId,
      meta: { email: target.email, name: target.name, role: target.role, clientId: target.clientId },
    },
  });
  revalidatePath('/projects');
  revalidatePath('/settings');
}

// Привязывает уже существующий логин с ролью «Продавец» (например заведённый раньше, до
// появления этой связи, или созданный в Настройках без выбора продавца) к продавцу — без
// создания нового логина и без повторной отправки приглашения.
async function linkAccessAction(formData: FormData) {
  'use server';
  const admin = await requireUser();
  if (admin.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const clientId = String(formData.get('clientId') || '');
  const userId = String(formData.get('userId') || '');
  if (!clientId || !userId) return;
  const target = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (target.role !== 'CLIENT') throw new Error('Привязать к продавцу можно только логин с ролью «Продавец».');

  await prisma.user.update({ where: { id: userId }, data: { clientId } });
  await prisma.activityLog.create({
    data: { actorId: admin.id, actorName: admin.name, action: 'user.linkClient', targetType: 'User', targetId: userId, meta: { clientId } },
  });
  revalidatePath('/projects');
  revalidatePath('/settings');
}

// Магазин — это продавец-проект (Project) вместе с его единственным подключением к площадке
// (Store): и то, и другое создаётся/переименовывается вместе, чтобы для пользователя это была
// одна сущность, а не два вложенных уровня.
async function createShopAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const clientId = String(formData.get('clientId') || '');
  const name = String(formData.get('name') || '').trim();
  const marketplaceRaw = String(formData.get('marketplace') || 'OZON');
  const marketplace = marketplaceRaw === 'WILDBERRIES' ? 'WILDBERRIES' : 'OZON';
  const ozonClientId = String(formData.get('ozonClientId') || '').trim();
  const ozonApiKey = String(formData.get('ozonApiKey') || '').trim();
  if (!clientId || !name) return;

  const project = await prisma.project.create({ data: { clientId, name, marketplace } });
  await prisma.store.create({
    data: {
      projectId: project.id,
      name,
      ozonClientId: ozonClientId || null,
      ozonApiKeyEncrypted: ozonApiKey ? encryptSecret(ozonApiKey) : null,
      ozonApiKeyLast4: ozonApiKey ? last4(ozonApiKey) : null,
    },
  });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'shop.create', targetType: 'Project', targetId: project.id, meta: { name, marketplace } },
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
  const usersOfClient = await prisma.user.findMany({ where: { clientId }, select: { id: true } });

  // Удаление продавца необратимо и удаляет вместе с ним все его магазины и всё, что было
  // загружено по ним (подключения к площадкам, товары, финансовые операции), а также все
  // логины (доступы), выданные этому продавцу — как вы и просили, доступ продавца не должен
  // «зависать» в системе после удаления самого продавца.
  await prisma.$transaction([
    prisma.financeTransaction.deleteMany({ where: { projectId: { in: projectIds } } }),
    prisma.product.deleteMany({ where: { projectId: { in: projectIds } } }),
    prisma.store.deleteMany({ where: { projectId: { in: projectIds } } }),
    prisma.projectAssignment.deleteMany({ where: { userId: { in: usersOfClient.map((u) => u.id) } } }),
    prisma.user.deleteMany({ where: { clientId } }),
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
      meta: { name: client.name, shopsDeleted: projectIds.length, accessDeleted: usersOfClient.length },
    },
  });
  revalidatePath('/projects');
  revalidatePath('/agency');
  revalidatePath('/dashboard');
  revalidatePath('/settings');
}

async function renameShopAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const projectId = String(formData.get('projectId') || '');
  const name = String(formData.get('name') || '').trim();
  if (!projectId || !name) return;
  await prisma.$transaction([
    prisma.project.update({ where: { id: projectId }, data: { name } }),
    // Название подключения (Store) держим синхронным с названием магазина — отдельно
    // пользователь его больше не видит и не редактирует.
    prisma.store.updateMany({ where: { projectId }, data: { name } }),
  ]);
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'shop.rename', targetType: 'Project', targetId: projectId, meta: { name } },
  });
  revalidatePath('/projects');
  revalidatePath('/agency');
}

async function changeShopMarketplaceAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const projectId = String(formData.get('projectId') || '');
  const marketplaceRaw = String(formData.get('marketplace') || '');
  if (!projectId || (marketplaceRaw !== 'OZON' && marketplaceRaw !== 'WILDBERRIES')) return;

  await prisma.project.update({ where: { id: projectId }, data: { marketplace: marketplaceRaw } });
  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'shop.setMarketplace', targetType: 'Project', targetId: projectId, meta: { marketplace: marketplaceRaw } },
  });
  revalidatePath('/projects');
}

// «Заменить продавца» — перенести магазин к другому продавцу (например, если завели его не
// под тем клиентом или бизнес перешёл к другому юрлицу).
async function changeShopOwnerAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const projectId = String(formData.get('projectId') || '');
  const clientId = String(formData.get('clientId') || '');
  if (!projectId || !clientId) return;
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  if (project.clientId === clientId) return;

  await prisma.project.update({ where: { id: projectId }, data: { clientId } });
  await prisma.activityLog.create({
    data: {
      actorId: user.id,
      actorName: user.name,
      action: 'shop.changeOwner',
      targetType: 'Project',
      targetId: projectId,
      meta: { fromClientId: project.clientId, toClientId: clientId },
    },
  });
  revalidatePath('/projects');
  revalidatePath('/agency');
}

async function deleteShopAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const projectId = String(formData.get('projectId') || '');
  if (!projectId) return;
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  // Необратимо: вместе с магазином удаляются его подключение к площадке, товары и финансовые
  // операции, чтобы не оставалось «осиротевших» данных. Назначения пользователей, сообщения
  // ИИ-аналитика и рекомендации по магазину удаляются автоматически на уровне базы (каскад).
  await prisma.$transaction([
    prisma.financeTransaction.deleteMany({ where: { projectId } }),
    prisma.product.deleteMany({ where: { projectId } }),
    prisma.store.deleteMany({ where: { projectId } }),
    prisma.project.delete({ where: { id: projectId } }),
  ]);

  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'shop.delete', targetType: 'Project', targetId: projectId, meta: { name: project.name } },
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

  // Логин продавца можно назначать только на магазины его же продавца — иначе легко случайно
  // открыть чужому продавцу доступ к чужому магазину. Менеджеров это ограничение не касается.
  const [project, target] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: projectId } }),
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
  ]);
  if (target.role === 'CLIENT' && target.clientId !== project.clientId) {
    throw new Error('Этот логин принадлежит другому продавцу — ему нельзя дать доступ к чужому магазину.');
  }

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

// Редактирование Client-Id/Api-Key в существующем подключении, без удаления магазина.
// Api-Key необязателен — если оставить поле пустым, прежний ключ сохраняется (перезаписывается
// только Client-Id). Если у магазина ещё нет подключения (Store), оно создаётся здесь же.
async function updateShopCredsAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (!isManagerOrAbove(user.role)) throw new Error('Недостаточно прав');
  const projectId = String(formData.get('projectId') || '');
  const ozonClientId = String(formData.get('ozonClientId') || '').trim();
  const ozonApiKey = String(formData.get('ozonApiKey') || '').trim();
  if (!projectId) return;
  await assertProjectAccess(user, projectId);

  const store = await prisma.store.findFirst({ where: { projectId } });
  const keyData = ozonApiKey ? { ozonApiKeyEncrypted: encryptSecret(ozonApiKey), ozonApiKeyLast4: last4(ozonApiKey) } : {};

  if (store) {
    await prisma.store.update({
      where: { id: store.id },
      data: {
        ozonClientId: ozonClientId || null,
        ...keyData,
        // Прежние результаты проверки/синхронизации относились к старым данным подключения —
        // после изменения Client-Id/Api-Key они уже не показательны.
        lastTestAt: null,
        lastTestOk: null,
        lastTestMessage: null,
      },
    });
  } else {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    await prisma.store.create({
      data: { projectId, name: project.name, ozonClientId: ozonClientId || null, ...keyData },
    });
  }

  await prisma.activityLog.create({
    data: { actorId: user.id, actorName: user.name, action: 'shop.updateCreds', targetType: 'Project', targetId: projectId, meta: { ozonClientId } },
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
    // Сначала помечаем весь текущий каталог магазина неактивным — актуальные товары
    // включатся обратно ниже, по мере обработки. То, что не встретилось в этом ответе
    // Ozon (товар сняли с продажи, а на аккаунтах, где раньше стояли другие Client-Id/Api-Key,
    // особенно — совсем другой каталог), останется неактивным и не будет попадать в список
    // «Товары» этого магазина. Сами записи не удаляем — на них могут ссылаться уже
    // посчитанные финансовые операции.
    await prisma.product.updateMany({ where: { projectId: store.projectId, storeId: store.id }, data: { active: false } });

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
          data: { name: p.name, sellPrice: p.sellPrice, sku: p.sku, offerId: p.offerId, active: true },
        })) as PRow;
      } else {
        canonical = (await prisma.product.create({
          data: { projectId: store.projectId, storeId: store.id, sku: p.sku, offerId: p.offerId, name: p.name, sellPrice: p.sellPrice, costPrice: 0, active: true },
        })) as PRow;
        productsImported += 1;
      }

      const canonicalId: string = canonical.id;
      for (const alias of p.skuAliases) productIdByAliasSku.set(alias, canonicalId);
      productIdByAliasSku.set(p.sku, canonicalId);
      // Строки заказа (posting.products[]), которыми теперь считаем выручку, иногда несут
      // только offer_id без числового sku — индексируем и по нему, чтобы не терять привязку к товару.
      productIdByAliasSku.set(p.offerId, canonicalId);

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

  let syncResult: { ok: boolean; message: string; operations: OzonOperation[]; productLines: OzonPostingProductLine[] };
  try {
    syncResult = await fetchOzonFinanceTransactions(creds, from, to);
  } catch (e) {
    syncResult = { ok: false, message: (e as Error).message, operations: [], productLines: [] };
  }

  // Себестоимость проданного Ozon не знает и не присылает — считаем сами:
  // quantity (из строки заказа) × Product.costPrice (введена вручную).
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
  let backfilledQty = 0;
  let backfilledProductLink = 0;
  let backfilledAccrualDate = 0;
  if (syncResult.ok) {
    const rows: {
      projectId: string;
      storeId: string;
      productId: string | null;
      type: 'REVENUE' | 'OZON_FEE' | 'COGS';
      category: string;
      amount: number;
      quantity?: number;
      date: Date;
      accrualDate?: Date | null;
      externalId: string;
    }[] = [];

    // Дата начисления Ozon по отправлению — берём из финансовых операций (op.operation_date —
    // это и есть accrual_date, см. flattenPostingAccruals в ozon.ts). Строки выручки/себестоимости
    // ниже датированы по дате ОФОРМЛЕНИЯ заказа (posting.products[]), а официальные отчёты Ozon
    // (например, «Отчёт по начислениям») считают период по дате НАЧИСЛЕНИЯ — она обычно на
    // несколько дней позже даты заказа, поэтому суммы за один и тот же период могут не совпадать
    // один в один. Сохраняем обе даты, чтобы на «Товары» можно было выбрать, по какой считать.
    const postingAccrualDate = new Map<string, Date>();
    for (const op of syncResult.operations) {
      if (!op.postingNumber || postingAccrualDate.has(op.postingNumber)) continue;
      const d = new Date(op.operation_date);
      if (!isNaN(d.getTime())) postingAccrualDate.set(op.postingNumber, d);
    }
    const lineRows: typeof rows = [];

    // Выручка и себестоимость — из состава заказа (posting.products[]: артикул, количество,
    // цена за единицу). Финансовый метод Ozon (/v1/finance/accrual/postings, ниже) надёжно
    // отдаёт только удержания — суммы самой продажи в нём нет, поэтому раньше «Выручка»
    // почти всегда оставалась нулевой при вполне реальных продажах и комиссиях.
    //
    // Привязка строки заказа к товару: пробуем сначала по offer_id (артикул продавца —
    // стабилен между синхронизациями и не меняется при переиздании карточки), и только
    // если его нет — по числовому SKU Ozon. Раньше было наоборот (сначала SKU), а SKU у
    // Ozon может смениться для того же товара (например, после переиздания карточки) —
    // тогда строки старых заказов несли уже не входящий в текущие алиасы товара SKU, и
    // реальные продажи «терялись» на странице «Товары» (сумма при этом не пропадала
    // совсем — без привязки к товару она попадала в общие «Расходы»/«Обзор», см. ниже).
    const resolveLineProductId = (line: OzonPostingProductLine): string | null => {
      if (line.offerId) {
        const byOffer = productIdByAliasSku.get(line.offerId);
        if (byOffer) return byOffer;
      }
      if (line.sku) {
        const bySku = productIdByAliasSku.get(line.sku);
        if (bySku) return bySku;
      }
      return null;
    };

    for (const line of syncResult.productLines) {
      const date = new Date(line.date);
      // Ключ externalId — как раньше (SKU, если есть, иначе offer_id): его нельзя менять
      // задним числом, иначе уже сохранённые строки на пересинхронизации задвоятся.
      // Привязка к товару (productId) теперь считается отдельно, через resolveLineProductId.
      const lineKey = line.sku ?? line.offerId;
      const productId = resolveLineProductId(line);
      const revenue = line.price * line.quantity;
      if (revenue <= 0) continue;

      const accrualDate = postingAccrualDate.get(line.postingNumber) ?? null;

      lineRows.push({
        projectId: store.projectId,
        storeId: store.id,
        productId,
        type: 'REVENUE',
        category: 'Продажи Ozon',
        amount: revenue,
        quantity: line.quantity,
        date,
        accrualDate,
        externalId: `${line.postingNumber}:${lineKey ?? 'x'}:revenue`,
      });

      const costPrice = productId ? productCostPriceById.get(productId) : undefined;
      if (productId && costPrice && costPrice > 0) {
        lineRows.push({
          projectId: store.projectId,
          storeId: store.id,
          productId,
          type: 'COGS',
          category: 'Себестоимость проданных товаров',
          amount: costPrice * line.quantity,
          date,
          accrualDate,
          externalId: `${line.postingNumber}:${lineKey ?? 'x'}:cogs`,
        });
      }
    }

    // Ozon отдаёт sku далеко не в каждой строке начисления — часть сборов (особенно по
    // отправлениям с несколькими товарами) приходит вообще без привязки к конкретному
    // товару, и раньше такие сборы просто нигде не учитывались в разбивке по товару на
    // странице «Товары» (хотя в общих «Расходах» и в «Обзоре» они по-прежнему были — там
    // считаем по всем операциям без разбора). posting_number в начислении есть всегда, а
    // состав отправления (кто именно в нём был и на какую сумму) мы уже знаем из
    // productLines — по нему довосстанавливаем привязку: если в отправлении был один
    // товар, сбор целиком его; если несколько — делим сбор между ними пропорционально
    // выручке по каждому в этом отправлении.
    const postingProductRevenue = new Map<string, Map<string, number>>();
    for (const line of syncResult.productLines) {
      const productId = resolveLineProductId(line);
      const revenue = line.price * line.quantity;
      if (!productId || revenue <= 0) continue;
      const byProduct = postingProductRevenue.get(line.postingNumber) ?? new Map<string, number>();
      byProduct.set(productId, (byProduct.get(productId) ?? 0) + revenue);
      postingProductRevenue.set(line.postingNumber, byProduct);
    }

    // Комиссии, логистика и прочие удержания Ozon — из финансового метода. Строки с
    // положительной суммой там редки (не относятся к продаже товара — например, разовая
    // компенсация) и учитываются отдельной, явно помеченной категорией, чтобы не задваивать
    // выручку, которую мы уже посчитали выше по составу заказа.
    //
    // Каждую операцию сначала раскладываем в 1 (привязана к товару или не привязана вовсе)
    // или несколько (разбита между товарами одного отправления) «кандидатных» строк, но не
    // сразу в общий rows — сверяем с уже сохранённой версией той же операции (по «базовому»
    // externalId без суффикса товара). Иначе при повторной синхронизации, когда привязка
    // задним числом восстановилась (см. postingProductRevenue выше), старая безтоварная
    // строка осталась бы в базе, а новая (или разбитая) добавилась бы поверх — сумма
    // задвоилась бы.
    const opRowsByBase = new Map<
      string,
      { productId: string | null; type: 'OZON_FEE' | 'REVENUE'; category: string; amount: number; date: Date; accrualDate: Date; externalId: string }[]
    >();
    for (const op of syncResult.operations) {
      const date = new Date(op.operation_date);
      const net = op.amount || 0;
      if (net === 0) continue;
      const type: 'OZON_FEE' | 'REVENUE' = net < 0 ? 'OZON_FEE' : 'REVENUE';
      const amountAbs = Math.abs(net);
      const category =
        net < 0
          ? op.operation_type_name || 'Комиссия Ozon'
          : op.operation_type_name
            ? `Прочее начисление Ozon: ${op.operation_type_name}`
            : 'Прочие начисления Ozon';
      const externalIdBase = net < 0 ? `${op.operation_id}:fee` : `${op.operation_id}:revenue`;

      let directProductId = op.sku ? productIdByAliasSku.get(op.sku) ?? null : null;
      if (!directProductId && op.postingNumber) {
        const byProduct = postingProductRevenue.get(op.postingNumber);
        if (byProduct && byProduct.size === 1) {
          directProductId = Array.from(byProduct.keys())[0];
        }
      }

      if (directProductId) {
        opRowsByBase.set(externalIdBase, [
          { productId: directProductId, type, category, amount: amountAbs, date, accrualDate: date, externalId: externalIdBase },
        ]);
        continue;
      }

      // Ни sku, ни однозначного единственного товара в отправлении — если отправление
      // известно и в нём было несколько товаров, делим сбор между ними пропорционально
      // их выручке в этом отправлении, а не теряем сбор целиком.
      const byProduct = op.postingNumber ? postingProductRevenue.get(op.postingNumber) : undefined;
      const totalRevenue = byProduct ? Array.from(byProduct.values()).reduce((s, v) => s + v, 0) : 0;
      if (byProduct && byProduct.size > 1 && totalRevenue > 0) {
        opRowsByBase.set(
          externalIdBase,
          Array.from(byProduct.entries()).map(([productId, revenue]) => ({
            productId,
            type,
            category,
            amount: amountAbs * (revenue / totalRevenue),
            date,
            accrualDate: date,
            externalId: `${externalIdBase}:${productId}`,
          })),
        );
        continue;
      }

      // Совсем не удалось привязать (отправление не найдено среди productLines за этот
      // период, например возврат по заказу из более раннего периода) — сохраняем без
      // товара, как раньше, чтобы сумма не терялась хотя бы в общих расходах.
      opRowsByBase.set(externalIdBase, [
        { productId: null, type, category, amount: amountAbs, date, accrualDate: date, externalId: externalIdBase },
      ]);
    }

    // Сверяем с уже сохранёнными строками этих же операций (по базовому externalId).
    const opBaseIds = Array.from(opRowsByBase.keys());
    const existingOpRows = opBaseIds.length
      ? await prisma.financeTransaction.findMany({
          where: { storeId: store.id, externalId: { in: opBaseIds } },
          select: { id: true, externalId: true, productId: true, accrualDate: true },
        })
      : [];
    const existingOpByBase = new Map(existingOpRows.map((e) => [e.externalId as string, e]));

    for (const [baseId, candidateRows] of opRowsByBase) {
      const existing = existingOpByBase.get(baseId);
      const isSplit = candidateRows.length > 1;
      if (!isSplit) {
        const candidate = candidateRows[0];
        if (existing) {
          // Строка с таким externalId уже есть (была сохранена раньше, возможно ещё без
          // привязки к товару/даты начисления). Новую не добавляем — только дозаполняем то,
          // чего раньше не было.
          const patch: { productId?: string; accrualDate?: Date } = {};
          if (existing.productId == null && candidate.productId != null) patch.productId = candidate.productId;
          if (existing.accrualDate == null && candidate.accrualDate != null) patch.accrualDate = candidate.accrualDate;
          if (Object.keys(patch).length > 0) {
            await prisma.financeTransaction.update({ where: { id: existing.id }, data: patch });
          }
        } else {
          rows.push({ projectId: store.projectId, storeId: store.id, ...candidate });
        }
      } else {
        // Разбито на несколько товаров. Если раньше эта операция была сохранена одной
        // безтоварной строкой (старый формат externalId, без суффикса товара) — удаляем
        // её, иначе сумма задвоится с новыми, per-товарными строками.
        if (existing) {
          await prisma.financeTransaction.delete({ where: { id: existing.id } });
        }
        for (const candidate of candidateRows) {
          rows.push({ projectId: store.projectId, storeId: store.id, ...candidate });
        }
      }
    }

    // Строки выручки/себестоимости из состава заказа (lineRows), синхронизированные ещё до
    // появления поля quantity, до починки привязки по offer_id или до появления accrualDate,
    // уже лежат в базе (createMany со skipDuplicates их не тронет — задваивать нечего, но и
    // недостающие поля сами не появятся). Раз уж период пересинхронизируется, заодно бесшумно
    // дозаполняем то, чего раньше не было: quantity — чтобы «Кол-во, шт» не показывало пусто по
    // старым продажам, productId — чтобы продажи, ранее «потерянные» из-за смены SKU, задним
    // числом вернулись к своему товару, и accrualDate — чтобы старые строки тоже попадали в
    // подсчёт «по дате начисления» на «Товары» (без повторной синхронизации истории — суммы те
    // же, просто дозаполняются недостающие поля).
    const newLineRows: typeof rows = [];
    if (lineRows.length > 0) {
      const existing = await prisma.financeTransaction.findMany({
        where: { storeId: store.id, externalId: { in: lineRows.map((r) => r.externalId) } },
        select: { id: true, externalId: true, quantity: true, productId: true, accrualDate: true },
      });
      const existingByExternalId = new Map(existing.map((e) => [e.externalId as string, e]));
      for (const r of lineRows) {
        const match = existingByExternalId.get(r.externalId);
        if (!match) {
          newLineRows.push(r);
          continue;
        }
        const patch: { quantity?: number; productId?: string; accrualDate?: Date } = {};
        if (match.quantity == null && r.quantity != null) patch.quantity = r.quantity;
        if (match.productId == null && r.productId != null) patch.productId = r.productId;
        if (match.accrualDate == null && r.accrualDate != null) patch.accrualDate = r.accrualDate;
        if (Object.keys(patch).length > 0) {
          await prisma.financeTransaction.update({ where: { id: match.id }, data: patch });
          if (patch.quantity !== undefined) backfilledQty += 1;
          if (patch.productId !== undefined) backfilledProductLink += 1;
          if (patch.accrualDate !== undefined) backfilledAccrualDate += 1;
        }
      }
    }

    const allNewRows = [...rows, ...newLineRows];
    if (allNewRows.length > 0) {
      const created = await prisma.financeTransaction.createMany({ data: allNewRows, skipDuplicates: true });
      imported = created.count;
    }
  }

  // «Позаказный отчёт о реализации» — штрихкод, доставлено/возвращено шт, баллы покупателя,
  // партнёрские программы банков (см. комментарий у fetchRealizationReport/ProductRealizationMonth).
  // Ozon отдаёт его только помесячно и только за уже ЗАКРЫТЫЙ календарный месяц — поэтому просто
  // пробуем каждый календарный месяц, попадающий в период синхронизации, и молча пропускаем те,
  // за которые Ozon ещё не готов отдать отчёт (это ожидаемо для текущего/недавнего месяца, а не
  // ошибка синхронизации).
  let realizationMonthsOk = 0;
  let realizationMonthsSkipped = 0;
  let realizationRowsMatched = 0;
  let barcodesUpdated = 0;
  if (productsResult.ok) {
    const months: { year: number; month: number }[] = [];
    {
      const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
      const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
      for (let guard = 0; guard < 24 && cur <= end; guard++) {
        months.push({ year: cur.getUTCFullYear(), month: cur.getUTCMonth() + 1 });
        cur.setUTCMonth(cur.getUTCMonth() + 1);
      }
    }
    for (const { year, month } of months) {
      let result;
      try {
        result = await fetchRealizationReport(creds, year, month);
      } catch (e) {
        result = { ok: false, message: (e as Error).message, rows: [] };
      }
      if (!result.ok || result.rows.length === 0) {
        realizationMonthsSkipped += 1;
        continue;
      }
      realizationMonthsOk += 1;
      for (const row of result.rows) {
        const productId = (row.offerId && productIdByAliasSku.get(row.offerId)) || (row.sku && productIdByAliasSku.get(row.sku)) || null;
        if (!productId) continue;
        realizationRowsMatched += 1;
        if (row.barcode) {
          await prisma.product.update({ where: { id: productId }, data: { barcode: row.barcode } });
          barcodesUpdated += 1;
        }
        await prisma.productRealizationMonth.upsert({
          where: { productId_storeId_year_month: { productId, storeId: store.id, year, month } },
          create: {
            projectId: store.projectId,
            storeId: store.id,
            productId,
            year,
            month,
            deliveredQty: row.deliveredQty,
            returnedQty: row.returnedQty,
            bonusAmount: row.bonusAmount,
            starsAmount: row.starsAmount,
            bankCoinvestmentAmount: row.bankCoinvestmentAmount,
          },
          update: {
            deliveredQty: row.deliveredQty,
            returnedQty: row.returnedQty,
            bonusAmount: row.bonusAmount,
            starsAmount: row.starsAmount,
            bankCoinvestmentAmount: row.bankCoinvestmentAmount,
          },
        });
      }
    }
  }

  const parts = [
    productsResult.ok ? `товаров: ${productsResult.products.length} (новых: ${productsImported})` : `товары — ошибка: ${productsResult.message}`,
    syncResult.ok
      ? `${syncResult.message} · новых операций сохранено: ${imported}${backfilledQty > 0 ? ` · кол-во дозаполнено у ${backfilledQty} старых строк выручки` : ''}${backfilledProductLink > 0 ? ` · привязка к товару восстановлена у ${backfilledProductLink} старых строк` : ''}${backfilledAccrualDate > 0 ? ` · дата начисления дозаполнена у ${backfilledAccrualDate} старых строк` : ''}`
      : `операции — ошибка: ${syncResult.message}`,
    realizationMonthsOk > 0
      ? `отчёт о реализации: ${realizationMonthsOk} закрытых месяцев учтено, товарных строк сопоставлено: ${realizationRowsMatched}${barcodesUpdated > 0 ? ` · штрихкод обновлён у ${barcodesUpdated}` : ''}${realizationMonthsSkipped > 0 ? ` · месяцев ещё не закрыто/недоступно: ${realizationMonthsSkipped}` : ''}`
      : `отчёт о реализации: за выбранный период пока нет закрытых месяцев (Ozon публикует не раньше 5 числа следующего месяца) — штрихкод/доставлено/возвращено появятся после того, как месяц закроется и магазин пересинхронизируется`,
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
      meta: { ok: overallOk, imported, productsImported, days, realizationMonthsOk, realizationRowsMatched, barcodesUpdated },
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

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: { accessLink?: string; accessEmail?: string; accessError?: string };
}) {
  const user = await requireUser();
  if (!isManagerOrAbove(user.role)) redirect('/dashboard');
  const isAdmin = user.role === 'SUPER_ADMIN';

  const clients = await prisma.client.findMany({
    include: {
      projects: { include: { stores: true, assignments: { include: { user: true } } } },
      users: { orderBy: { createdAt: 'asc' } },
    },
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
      {isAdmin && searchParams.accessError && (
        <div className="panel" style={{ borderColor: 'var(--bad)' }}>
          <div style={{ color: 'var(--bad)', fontWeight: 600 }}>{searchParams.accessError}</div>
        </div>
      )}
      {isAdmin && searchParams.accessLink && (
        <div className="panel">
          <h2>Ссылка-приглашение для {searchParams.accessEmail}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -8, marginBottom: 10 }}>
            Письмо отправить не удалось (см. историю действий в Настройках — там причина) — передайте ссылку
            вручную, она действует 7 дней:
          </p>
          <code style={{ display: 'block', padding: '8px 10px', background: 'var(--bg-muted, #f4f4f5)', borderRadius: 6, wordBreak: 'break-all', fontSize: 12.5 }}>
            {searchParams.accessLink}
          </code>
        </div>
      )}
      <div className="panel">
        <h2>Продавцы и магазины</h2>
        {visibleClients.length === 0 && <div className="empty-state">Магазинов пока нет.</div>}
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
                    style={{ fontSize: 15, fontWeight: 600, padding: '4px 8px', width: 260 }}
                  />
                  <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} type="submit">
                    Сохранить
                  </button>
                </form>
              ) : (
                <h3 style={{ margin: 0 }}>{client.name}</h3>
              )}
              {isAdmin && (
                <form action={deleteClientAction}>
                  <input type="hidden" name="clientId" value={client.id} />
                  <button className="btn btn-danger" style={{ padding: '4px 10px', fontSize: 12 }} type="submit">
                    Удалить продавца
                  </button>
                </form>
              )}
            </div>

            {isAdmin && (
              <details style={{ marginBottom: 10, padding: '8px 10px', background: 'var(--bg-muted, #f4f4f5)', borderRadius: 6 }}>
                <summary
                  style={{ fontSize: 12.5, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}
                >
                  Доступ продавца{client.users.length > 0 ? ` (${client.users.length})` : ''}
                </summary>
                <div style={{ marginTop: 8 }}>
                {client.users.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
                    Доступа пока нет — продавец не может войти в систему.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                    {client.users.map((u) => (
                      <div key={u.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
                        <span>
                          {u.name} ({u.email})
                        </span>
                        {u.inviteAcceptedAt ? (
                          <span className="pill ok">Доступ активен</span>
                        ) : (
                          <>
                            <span className="pill warning">Ждёт входа по ссылке</span>
                            <form action={resendAccessAction}>
                              <input type="hidden" name="userId" value={u.id} />
                              <button className="btn" style={{ padding: '2px 8px', fontSize: 11 }} type="submit">
                                Отправить ссылку ещё раз
                              </button>
                            </form>
                          </>
                        )}
                        <form action={removeAccessAction}>
                          <input type="hidden" name="userId" value={u.id} />
                          <button className="btn btn-danger" style={{ padding: '2px 8px', fontSize: 11 }} type="submit">
                            Удалить доступ
                          </button>
                        </form>
                      </div>
                    ))}
                  </div>
                )}
                <form action={grantAccessAction} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                  <input type="hidden" name="clientId" value={client.id} />
                  <input type="text" name="name" placeholder="Имя" required style={{ fontSize: 12, padding: '3px 6px', width: 140 }} />
                  <input type="email" name="email" placeholder="Email" required style={{ fontSize: 12, padding: '3px 6px', width: 190 }} />
                  <button className="btn" style={{ padding: '3px 8px', fontSize: 11 }} type="submit">
                    Дать доступ
                  </button>
                </form>
                {(() => {
                  const unlinked = allUsers.filter((u) => u.role === 'CLIENT' && !u.clientId);
                  if (unlinked.length === 0) return null;
                  return (
                    <form action={linkAccessAction} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <input type="hidden" name="clientId" value={client.id} />
                      <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>или привязать уже существующий логин:</span>
                      <select name="userId" style={{ fontSize: 12, padding: '3px 6px' }}>
                        {unlinked.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name} ({u.email})
                          </option>
                        ))}
                      </select>
                      <button className="btn" style={{ padding: '3px 8px', fontSize: 11 }} type="submit">
                        Привязать
                      </button>
                    </form>
                  );
                })()}
                </div>
              </details>
            )}

            <table className="data-table">
              <thead>
                <tr>
                  <th>Магазин</th>
                  <th>Площадка</th>
                  <th className="tooltip-hint" title="Ставка налога от выручки (например 6 для УСН «Доходы» 6%) — задаётся вручную, Ozon её не знает и не присылает">
                    Налог, %
                  </th>
                  <th>Команда</th>
                  {isAdmin && <th>Назначить</th>}
                  {isAdmin && <th>Продавец</th>}
                  {isAdmin && <th>Действия</th>}
                </tr>
              </thead>
              <tbody>
                {client.projects.map((p) => (
                  <tr key={p.id}>
                    <td style={{ minWidth: 240 }}>
                      {isAdmin ? (
                        <form action={renameShopAction} style={{ display: 'flex', gap: 4 }}>
                          <input type="hidden" name="projectId" value={p.id} />
                          <input
                            type="text"
                            name="name"
                            defaultValue={p.name}
                            style={{ width: 220, padding: '4px 6px', fontSize: 12.5 }}
                          />
                          <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                            ✓
                          </button>
                        </form>
                      ) : (
                        p.name
                      )}
                    </td>
                    <td>
                      {isAdmin ? (
                        <form action={changeShopMarketplaceAction} style={{ display: 'flex', gap: 4 }}>
                          <input type="hidden" name="projectId" value={p.id} />
                          <select name="marketplace" defaultValue={p.marketplace} style={{ fontSize: 12, padding: '4px 6px' }}>
                            <option value="OZON">Ozon</option>
                            <option value="WILDBERRIES">Wildberries</option>
                          </select>
                          <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                            ✓
                          </button>
                        </form>
                      ) : (
                        <span className="pill">{MARKETPLACE_LABEL[p.marketplace] ?? p.marketplace}</span>
                      )}
                    </td>
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
                    {isAdmin &&
                      (() => {
                        // Менеджеров можно назначать на любой магазин; логин продавца — только
                        // на магазины его же продавца (доступ выдаётся точечно, по магазинам).
                        const assignable = allUsers.filter((u) => u.role === 'MANAGER' || (u.role === 'CLIENT' && u.clientId === client.id));
                        return (
                          <td>
                            {assignable.length === 0 ? (
                              <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>
                                Нет доступных логинов — выдайте доступ продавцу выше.
                              </span>
                            ) : (
                              <form action={assignUserAction} style={{ display: 'flex', gap: 6 }}>
                                <input type="hidden" name="projectId" value={p.id} />
                                <select name="userId" style={{ fontSize: 12, padding: '4px 6px' }}>
                                  {assignable.map((u) => (
                                    <option key={u.id} value={u.id}>
                                      {u.name}
                                    </option>
                                  ))}
                                </select>
                                <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }}>
                                  Назначить
                                </button>
                              </form>
                            )}
                          </td>
                        );
                      })()}
                    {isAdmin && (
                      <td>
                        <form action={changeShopOwnerAction} style={{ display: 'flex', gap: 4 }}>
                          <input type="hidden" name="projectId" value={p.id} />
                          <select name="clientId" defaultValue={client.id} style={{ fontSize: 12, padding: '4px 6px' }}>
                            {clients.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                          <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                            Заменить
                          </button>
                        </form>
                      </td>
                    )}
                    {isAdmin && (
                      <td>
                        <form action={deleteShopAction}>
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
        <h2>Подключение к площадке</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5, marginTop: -8, marginBottom: 14 }}>
          Client-Id и Api-Key берутся в личном кабинете Ozon Seller: Настройки → Seller API. Ключ хранится на
          сервере в зашифрованном виде и повторно нигде не показывается — только последние 4 символа, чтобы
          понять, какой ключ сохранён. Поле Api-Key можно оставить пустым, чтобы не менять уже сохранённый ключ —
          заполняется только при первом подключении или замене ключа. Подключение для Wildberries появится
          позже — площадку для магазина уже можно отметить заранее в таблице выше.
        </p>

        {visibleClients.flatMap((c) => c.projects).length === 0 && <div className="empty-state">Магазинов пока нет — добавьте первый ниже.</div>}

        {visibleClients.map((client) =>
          client.projects.map((p) => {
            const store = p.stores[0];
            return (
              <div key={p.id} style={{ marginBottom: 18 }}>
                <h3>
                  {client.name} · {p.name} · {MARKETPLACE_LABEL[p.marketplace] ?? p.marketplace}
                </h3>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <form action={updateShopCredsAction} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <input type="hidden" name="projectId" value={p.id} />
                    <input
                      type="text"
                      name="ozonClientId"
                      placeholder="Ozon Client-Id"
                      defaultValue={store?.ozonClientId ?? ''}
                      style={{ width: 130, padding: '4px 6px', fontSize: 12.5 }}
                    />
                    <input
                      type="password"
                      name="ozonApiKey"
                      placeholder={store?.ozonApiKeyLast4 ? `оставить ••••${store.ozonApiKeyLast4}` : 'Ozon Api-Key'}
                      autoComplete="off"
                      style={{ width: 170, padding: '4px 6px', fontSize: 12.5 }}
                    />
                    <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                      Сохранить
                    </button>
                  </form>

                  {store && (
                    <>
                      <div style={{ fontSize: 12.5 }}>
                        {store.lastTestAt ? (
                          <span className={`pill ${store.lastTestOk ? 'ok' : 'critical'}`}>{store.lastTestOk ? 'Подключено' : 'Ошибка'}</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>ещё не проверялось</span>
                        )}
                        {store.lastTestMessage && (
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, maxWidth: 220 }}>{store.lastTestMessage}</div>
                        )}
                        <form action={testStoreConnectionAction} style={{ marginTop: 4 }}>
                          <input type="hidden" name="storeId" value={store.id} />
                          <button className="btn" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                            Проверить
                          </button>
                        </form>
                      </div>

                      <div style={{ fontSize: 12.5 }}>
                        {store.lastSyncAt ? (
                          <span className={`pill ${store.lastSyncOk ? 'ok' : 'critical'}`}>{store.lastSyncOk ? 'Успешно' : 'Ошибка'}</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>синхронизация не запускалась</span>
                        )}
                        {store.lastSyncMessage && (
                          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, maxWidth: 260 }}>{store.lastSyncMessage}</div>
                        )}
                        <form action={syncStoreAction} style={{ marginTop: 4 }}>
                          <input type="hidden" name="storeId" value={store.id} />
                          <input type="hidden" name="days" value={30} />
                          <button className="btn btn-primary" style={{ padding: '4px 8px', fontSize: 12 }} type="submit">
                            Синхронизировать
                          </button>
                        </form>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          }),
        )}
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
          <h2>Добавить магазин</h2>
          <form action={createShopAction} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select name="clientId">
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input type="text" name="name" placeholder="Название магазина" required />
            <select name="marketplace" defaultValue="OZON">
              <option value="OZON">Ozon</option>
              <option value="WILDBERRIES">Wildberries</option>
            </select>
            <input type="text" name="ozonClientId" placeholder="Ozon Client-Id (можно позже)" />
            <input type="password" name="ozonApiKey" placeholder="Ozon Api-Key (можно позже)" autoComplete="off" />
            <button className="btn btn-primary" type="submit">
              Создать
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
