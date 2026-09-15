import { requireUser } from '@/lib/authz';
import { Sidebar } from '@/components/Sidebar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div className="app-shell">
      <Sidebar role={user.role} userName={user.name ?? user.email ?? ''} />
      <main className="main">{children}</main>
    </div>
  );
}
