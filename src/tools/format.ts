import { money } from './context.js';
import { WEEKDAY_NAMES } from '../domain/openNow.js';
import type { MenuItemHit, Restaurant } from '../domain/types.js';

/** Human-readable renderers. Kept apart from tool logic so both stay readable. */

export function openLabel(r: Restaurant): string {
  const st = r.openStatus;
  if (!st) return '';
  if (st.scheduleUnavailable) return ' · hours unknown';
  if (st.isOpen) return st.closesAt ? ` · OPEN until ${st.closesAt}` : ' · OPEN';
  if (st.opensNext) {
    return ` · CLOSED, opens ${WEEKDAY_NAMES[st.opensNext.weekday] ?? ''} ${st.opensNext.time}`;
  }
  return ' · CLOSED';
}

export function restaurantLine(r: Restaurant, index?: number): string {
  const parts: string[] = [];
  if (r.rating !== undefined) parts.push(`${r.rating.toFixed(1)}★${r.reviewCount ? ` (${r.reviewCount})` : ''}`);
  if (r.distanceKm !== undefined) parts.push(`${r.distanceKm.toFixed(1)} km`);
  if (r.deliveryTimeMinutes !== undefined) parts.push(`~${r.deliveryTimeMinutes} min`);
  if (r.deliveryFee !== undefined) parts.push(`fee ${money(r.deliveryFee, r.market)}`);
  if (r.minimumOrderAmount !== undefined) parts.push(`min ${money(r.minimumOrderAmount, r.market)}`);

  const prefix = index !== undefined ? `${index + 1}. ` : '';
  const cuisines = r.cuisines.length ? ` [${r.cuisines.slice(0, 3).join(', ')}]` : '';
  const promo = r.hasDiscount ? ' 🏷' : '';

  return (
    `${prefix}${r.name}${cuisines}${promo}\n` +
    `   ${parts.join(' · ')}${openLabel(r)}\n` +
    `   code: ${r.code}`
  );
}

export function restaurantList(list: Restaurant[], header: string): string {
  if (list.length === 0) {
    return `${header}\n\nNo restaurants matched. Try widening the search: drop a filter, increase the distance, or search a broader term.`;
  }
  return `${header}\n\n${list.map((r, i) => restaurantLine(r, i)).join('\n\n')}`;
}

export function itemHitLine(h: MenuItemHit, market: string, index: number): string {
  const price = money(h.price, market);
  const was = h.priceBeforeDiscount !== undefined ? ` (was ${money(h.priceBeforeDiscount, market)})` : '';
  const total =
    h.totalWithDelivery !== undefined ? ` · ${money(h.totalWithDelivery, market)} with delivery` : '';
  const bits: string[] = [];
  if (h.restaurantRating !== undefined) bits.push(`${h.restaurantRating.toFixed(1)}★`);
  if (h.distanceKm !== undefined) bits.push(`${h.distanceKm.toFixed(1)} km`);
  if (h.deliveryTimeMinutes !== undefined) bits.push(`~${h.deliveryTimeMinutes} min`);
  if (h.minimumOrderAmount !== undefined) bits.push(`min ${money(h.minimumOrderAmount, market)}`);

  return (
    `${index + 1}. ${h.name} — ${price}${was}${total}\n` +
    `   at ${h.restaurantName} (${h.restaurantCode})\n` +
    `   ${bits.join(' · ')}` +
    (h.description ? `\n   ${h.description.slice(0, 120)}` : '')
  );
}

export function bullet(label: string, value: string | number | undefined): string {
  return value === undefined || value === '' ? '' : `- ${label}: ${value}\n`;
}
