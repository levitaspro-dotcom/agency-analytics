import { prisma } from '../prisma';
import { decryptSecret } from '../crypto';
import { createAdapter } from './index';
import type { AiAdapter } from './types';

export async function getActiveAiProviderConfig() {
  return prisma.aiProviderConfig.findFirst({ where: { active: true }, orderBy: { updatedAt: 'desc' } });
}

export async function getActiveAiAdapter(): Promise<{
  adapter: AiAdapter;
  config: NonNullable<Awaited<ReturnType<typeof getActiveAiProviderConfig>>>;
} | null> {
  const config = await getActiveAiProviderConfig();
  if (!config) return null;
  const adapter = createAdapter(config.provider, { apiKey: decryptSecret(config.apiKeyEncrypted), model: config.model });
  return { adapter, config };
}
