import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const main = async () => {
  const trialEndsAt = new Date();
  trialEndsAt.setFullYear(trialEndsAt.getFullYear() + 1);
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'demo-burger-house' },
    update: { trialEndsAt },
    create: { name: 'Burger House', slug: 'demo-burger-house', trialEndsAt, settings: { create: { displayName: 'Burger House' } } }
  });
  await prisma.device.upsert({ where: { tokenHash: 'demo-screen-token' }, update: {}, create: { tenantId: tenant.id, name: 'Pantalla principal', tokenHash: 'demo-screen-token' } });
  await prisma.user.upsert({ where: { tenantId_email: { tenantId: tenant.id, email: 'admin@gametable.local' } }, update: {}, create: { tenantId: tenant.id, name: 'Administrador demo', email: 'admin@gametable.local', passwordHash: await bcrypt.hash('GameTableDemo2026!', 12), role: 'OWNER' } });
  console.log(`Tenant demo listo: ${tenant.slug}`);
};

main().finally(() => prisma.$disconnect());