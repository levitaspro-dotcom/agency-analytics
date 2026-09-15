export function resolvePeriod(searchParams: { from?: string; to?: string }) {
  const now = new Date();
  let from = searchParams.from ? new Date(searchParams.from) : new Date(now.getFullYear(), now.getMonth(), 1);
  let to = searchParams.to ? new Date(searchParams.to) : new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (isNaN(from.getTime())) from = new Date(now.getFullYear(), now.getMonth(), 1);
  if (isNaN(to.getTime())) to = now;

  // включаем весь день "до"
  to = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999);

  return { from, to };
}

export function previousPeriod(from: Date, to: Date) {
  const lengthMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - lengthMs);
  return { from: prevFrom, to: prevTo };
}

export function formatDate(d: Date) {
  return d.toLocaleDateString('ru-RU');
}

export function inputDate(d: Date) {
  return d.toISOString().slice(0, 10);
}
