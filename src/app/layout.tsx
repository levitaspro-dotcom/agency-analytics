import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Агентство · Аналитика',
  description: 'Финансовая аналитика и ИИ-аудит для проектов агентства',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
