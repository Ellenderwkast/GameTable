import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const main = async () => {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-burger-house' },
    update: {},
    create: { name: 'Burger House', slug: 'demo-burger-house', settings: { create: { displayName: 'Burger House' } } }
  });
  await prisma.device.upsert({ where: { tokenHash: 'demo-screen-token' }, update: {}, create: { tenantId: tenant.id, name: 'Pantalla principal', tokenHash: 'demo-screen-token' } });
  console.log(`Tenant demo listo: ${tenant.slug}`);
};

main().finally(() => prisma.$disconnect());