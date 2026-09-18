/**
 * Некоторые категории расходов Ozon (accrual_type.name из /v1/finance/accrual/types) приходят из
 * API только на английском — даже при language: "RU" у части типов начисления Ozon просто не
 * возвращает заполненный "description" (проверено на живых данных этого магазина, не ошибка
 * формирования запроса с нашей стороны). ozon.ts уже предпочитает "description" (русский) там, где
 * он есть — эта таблица закрывает то, что осталось.
 *
 * Применяется в двух местах:
 *  - lib/integrations/ozon.ts — как последний fallback при сохранении НОВЫХ операций, чтобы они
 *    сразу приходили по-русски;
 *  - lib/finance.ts / страницы «Расходы», «Товары», экспорт CSV — при отображении УЖЕ сохранённых
 *    старых операций (их category в базе мог остаться на английском ещё до этого fallback'а) —
 *    без миграции данных в базе.
 *
 * Намеренно закрываем только коды, которые реально встречались в данных — угадывать перевод для
 * незнакомого кода рискованнее, чем один раз показать его как есть (на английском): так хотя бы
 * видно, что именно не переведено, и это легко дополнить.
 */
const RU_CATEGORY_FALLBACK: Record<string, string> = {
  SaleCommission: 'Комиссия за продажу',
  BrandCommission: 'Комиссия за бренд',
  Logistic: 'Логистика',
  LastMileCourier: 'Курьерская доставка (последняя миля)',
  ReturnFlowLogistic: 'Логистика возврата',
  'Drop-Off Agent': 'Приём отправления в пункте (Drop-off)',
  DeliveryToHandoverPlaceByOzon: 'Доставка до места передачи Ozon',
  PackingFee: 'Упаковка',
  PackageCost: 'Стоимость упаковочных материалов',
  PickUpPointReturnAcceptance: 'Приём возврата в пункте выдачи',
  DefectFineShipmentDelayRate: 'Штраф за просрочку отгрузки',
};

export function translateCategory(raw: string): string {
  return RU_CATEGORY_FALLBACK[raw] ?? raw;
}
