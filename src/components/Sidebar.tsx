'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';

const NAV = [
  { href: '/dashboard', label: 'Обзор' },
  { href: '/products', label: 'Товары' },
  { href: '/expenses', label: 'Расходы' },
  { href: '/ai-analyst', label: 'ИИ-аналитик' },
  { href: '/reports', label: 'Отчёты' },
];

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Главный администратор',
  MANAGER: 'Менеджер',
  CLIENT: 'Продавец',
};

export function Sidebar({ role, userName }: { role: string; userName: string }) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">Агентство · Аналитика</div>
      <nav>
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} className={`nav-link ${pathname?.startsWith(item.href) ? 'active' : ''}`}>
            {item.label}
          </Link>
        ))}
        {(role === 'SUPER_ADMIN' || role === 'MANAGER') && (
          <>
            <div className="nav-section-title">Управление</div>
            <Link href="/projects" className={`nav-link ${pathname?.startsWith('/projects') ? 'active' : ''}`}>
              Проекты и команда
            </Link>
          </>
        )}
        {role === 'SUPER_ADMIN' && (
          <>
            <Link href="/agency" className={`nav-link ${pathname?.startsWith('/agency') ? 'active' : ''}`}>
              Агентство · все проекты
            </Link>
            <Link href="/settings" className={`nav-link ${pathname?.startsWith('/settings') ? 'active' : ''}`}>
              Настройки
            </Link>
          </>
        )}
      </nav>
      <div style={{ marginTop: 'auto', paddingTop: 16, borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
        <div style={{ marginBottom: 2, fontWeight: 600 }}>{userName}</div>
        <div style={{ marginBottom: 10, color: 'var(--text-muted)' }}>{ROLE_LABEL[role] ?? role}</div>
        <button className="btn" style={{ width: '100%' }} onClick={() => signOut({ callbackUrl: '/login' })}>
          Выйти
        </button>
      </div>
    </aside>
  );
}
