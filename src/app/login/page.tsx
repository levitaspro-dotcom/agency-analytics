'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await signIn('credentials', { email, password, redirect: false });
    setLoading(false);
    if (res?.error) {
      setError('Неверный email или пароль');
    } else {
      router.push('/dashboard');
      router.refresh();
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Вход в систему</h1>
        <p className="sub">Аналитика и ИИ-аудит для проектов агентства</p>
        {error && <div className="error-text">{error}</div>}
        <form onSubmit={onSubmit}>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input type="password" placeholder="Пароль" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button className="btn btn-primary" disabled={loading} type="submit">
            {loading ? 'Входим…' : 'Войти'}
          </button>
        </form>
        <div className="demo-creds">
          Демо-доступ:
          <br />
          Администратор: <code>admin@levitaspro.ru</code>
          <br />
          Менеджер: <code>manager@levitaspro.ru</code>
          <br />
          Продавец: <code>client@romashka.ru</code>
          <br />
          Пароль для всех: <code>Demo12345!</code>
        </div>
      </div>
    </div>
  );
}
