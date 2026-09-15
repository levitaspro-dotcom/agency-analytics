import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser, isManagerOrAbove } from '@/lib/authz';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

async function createClientAction(formData: FormData) {
  'use server';
  const user = await requireUser();
  if (user.role !== 'SUPER_ADMIN') throw new Error('Недостаточно прав');
  const name = String(formData.get('name') || '').trim();
  if (!name) return;
  const client = await prisma.client.create({ data: { name } });
  await prisma.activityLog.create({
    data: { actorId: user.id, action: 'client.create', targetType: 'Client', targetId: client.id, meta: { name } },
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
    data: { actorId: user.id, action: 'project.create', targetType: 'Project', targetId: project.id, meta: { name } },
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
    data: { actorId: user.id, action: 'assignment.create', targetType: 'Project', targetId: projectId, meta: { userId } },
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
    data: { actorId: user.id, action: 'assignment.remove', targetType: 'Project', targetId: a.projectId, meta: { userId: a.userId } },
  });
  revalidatePath('/projects');
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
