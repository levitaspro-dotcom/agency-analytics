const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

function monthsAgo(now, n, day = 1) {
  return new Date(now.getFullYear(), now.getMonth() - n, day);
}

async function main() {
  const existing = await prisma.user.count();
  if (existing > 0) {
    console.log('Seed skipped: users already exist.');
    return;
  }

  const passwordHash = await bcrypt.hash('Demo12345!', 10);

  const admin = await prisma.user.create({
    data: { email: 'admin@levitaspro.ru', name: 'Ольга (главный администратор)', role: 'SUPER_ADMIN', passwordHash },
  });
  const manager = await prisma.user.create({
    data: { email: 'manager@levitaspro.ru', name: 'Менеджер агентства', role: 'MANAGER', passwordHash },
  });
  const clientUser = await prisma.user.create({
    data: { email: 'client@romashka.ru', name: 'Клиент ООО «Ромашка»', role: 'CLIENT', passwordHash },
  });

  const client = await prisma.client.create({ data: { name: 'ООО «Ромашка»' } });
  const project = await prisma.project.create({ data: { clientId: client.id, name: 'Ромашка · Основной магазин' } });
  const store = await prisma.store.create({ data: { projectId: project.id, name: 'Ozon: Ромашка', ozonShopId: 'demo-12345' } });

  await prisma.projectAssignment.createMany({
    data: [
      { projectId: project.id, userId: manager.id },
      { projectId: project.id, userId: clientUser.id },
    ],
  });

  const mug = await prisma.product.create({ data: { projectId: project.id, storeId: store.id, name: 'Термокружка 350мл', sku: 'TK-350', sellPrice: 990, costPrice: 420 } });
  const towel = await prisma.product.create({ data: { projectId: project.id, storeId: store.id, name: 'Набор кухонных полотенец', sku: 'NKP-01', sellPrice: 690, costPrice: 630 } });
  const mat = await prisma.product.create({ data: { projectId: project.id, storeId: store.id, name: 'Силиконовый коврик для выпечки', sku: 'SKV-02', sellPrice: 450, costPrice: 260 } });
  const organizer = await prisma.product.create({ data: { projectId: project.id, storeId: store.id, name: 'Органайзер для специй', sku: 'ORG-07', sellPrice: 1290, costPrice: 1180 } });

  const now = new Date();
  const tx = [];

  function addRevenueCogs(product, month, units, feeRate = 0.15) {
    const revenue = product.sellPrice * units;
    const cogs = product.costPrice * units;
    const fee = revenue * feeRate;
    const date = monthsAgo(now, month, 10);
    tx.push({ projectId: project.id, storeId: store.id, productId: product.id, type: 'REVENUE', category: 'Продажи Ozon', amount: revenue, date });
    tx.push({ projectId: project.id, storeId: store.id, productId: product.id, type: 'COGS', category: 'Закупка товара', amount: cogs, date });
    tx.push({ projectId: project.id, storeId: store.id, productId: product.id, type: 'OZON_FEE', category: 'Комиссия за продажу', amount: fee, date });
  }

  const plan = [
    { month: 0, units: { mug: 140, towel: 90, mat: 60, organizer: 20 } },
    { month: 1, units: { mug: 120, towel: 100, mat: 55, organizer: 25 } },
    { month: 2, units: { mug: 110, towel: 95, mat: 50, organizer: 22 } },
  ];

  const monthRevenue = {};
  for (const p of plan) {
    addRevenueCogs(mug, p.month, p.units.mug);
    addRevenueCogs(towel, p.month, p.units.towel);
    addRevenueCogs(mat, p.month, p.units.mat);
    addRevenueCogs(organizer, p.month, p.units.organizer);
    monthRevenue[p.month] =
      mug.sellPrice * p.units.mug + towel.sellPrice * p.units.towel + mat.sellPrice * p.units.mat + organizer.sellPrice * p.units.organizer;

    tx.push({ projectId: project.id, storeId: store.id, type: 'OZON_FEE', category: 'Логистика', amount: 18000 + p.month * 1500, date: monthsAgo(now, p.month, 15) });
    tx.push({ projectId: project.id, storeId: store.id, type: 'TAX', category: 'УСН 6% от выручки', amount: monthRevenue[p.month] * 0.06, date: monthsAgo(now, p.month, 20) });
  }

  tx.push({ projectId: project.id, storeId: store.id, type: 'EXTERNAL_EXPENSE', category: 'Реклама (Яндекс.Директ)', amount: 22000, date: monthsAgo(now, 0, 5) });
  tx.push({ projectId: project.id, storeId: store.id, type: 'EXTERNAL_EXPENSE', category: 'Реклама (Яндекс.Директ)', amount: 14000, date: monthsAgo(now, 1, 5) });
  tx.push({ projectId: project.id, storeId: store.id, type: 'EXTERNAL_EXPENSE', category: 'Фотосъёмка и контент', amount: 9000, date: monthsAgo(now, 0, 3) });
  tx.push({ projectId: project.id, storeId: store.id, type: 'EXTERNAL_EXPENSE', category: 'Услуги агентства', amount: 30000, date: monthsAgo(now, 0, 1) });
  tx.push({ projectId: project.id, storeId: store.id, type: 'EXTERNAL_EXPENSE', category: 'Услуги агентства', amount: 30000, date: monthsAgo(now, 1, 1) });

  await prisma.financeTransaction.createMany({ data: tx });

  await prisma.activityLog.create({
    data: { actorId: admin.id, action: 'seed.init', targetType: 'System', meta: { note: 'Демонстрационные данные созданы при первом деплое' } },
  });

  console.log('Seed complete:', { admin: admin.email, manager: manager.email, client: clientUser.email, transactions: tx.length });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
