import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from './auth';
import { prisma } from './prisma';

export type SessionUser = { id: string; role: string; name?: string | null; email?: string | null };

export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  return session.user as SessionUser;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

export function isManagerOrAbove(role: string) {
  return role === 'SUPER_ADMIN' || role === 'MANAGER';
}

export async function listAccessibleProjects(user: SessionUser) {
  if (user.role === 'SUPER_ADMIN') {
    return prisma.project.findMany({
      include: { client: true, stores: true },
      orderBy: { createdAt: 'asc' },
    });
  }
  return prisma.project.findMany({
    where: { assignments: { some: { userId: user.id } } },
    include: { client: true, stores: true },
    orderBy: { createdAt: 'asc' },
  });
}

export class ForbiddenError extends Error {}

export async function assertProjectAccess(user: SessionUser, projectId: string) {
  if (user.role === 'SUPER_ADMIN') return true;
  const assignment = await prisma.projectAssignment.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
  });
  if (!assignment) throw new ForbiddenError('Нет доступа к проекту');
  return assignment;
}
