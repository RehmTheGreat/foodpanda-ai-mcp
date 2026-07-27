import { money } from './context.js';
import { WEEKDAY_NAMES } from '../domain/openNow.js';
import type { Deal, Discount, Fees, MenuItemHit, Restaurant } from '../domain/types.js';

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
  else if (r.isUnrated) parts.push('unrated');
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
  else if (h.restaurantIsUnrated) bits.push('unrated');
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

/** Render the additive charges. Empty string when the vendor published none. */
export function feesBlock(fees: Fees | undefined, market: string): string {
  if (!fees) return '';
  const lines: string[] = [];

  if (fees.minimumOrderAmount !== undefined) {
    lines.push(`- Minimum order: ${money(fees.minimumOrderAmount, market)}`);
  }
  if (fees.smallOrderFee !== undefined) {
    lines.push(
      `- Small order fee: ${money(fees.smallOrderFee, market)}` +
        (fees.minimumOrderAmount !== undefined
          ? ` (applies below ${money(fees.minimumOrderAmount, market)})`
          : ''),
    );
  }
  if (fees.deliveryFee !== undefined) lines.push(`- Delivery fee: ${money(fees.deliveryFee, market)}`);

  if (fees.isServiceFeeEnabled === false) {
    lines.push('- Service fee: none');
  } else if (fees.serviceFeePercent !== undefined) {
    lines.push(`- Service fee: ${fees.serviceFeePercent}%`);
  } else if (fees.isServiceFeeEnabled === true) {
    lines.push('- Service fee: charged (rate not published)');
  }

  if (fees.vatPercent !== undefined) {
    const incl =
      fees.isVatIncludedInPrice === true
        ? ' (already included in menu prices)'
        : fees.isVatIncludedInPrice === false
          ? ' (added at checkout)'
          : '';
    lines.push(`- VAT: ${fees.vatPercent}%${incl}`);
  }

  return lines.length ? `\nFees:\n${lines.join('\n')}\n` : '';
}

/** Render deals and discounts with their numbers, not just their labels. */
export function offersBlock(deals: Deal[], discounts: Discount[], market: string): string {
  const parts: string[] = [];

  if (deals.length) {
    parts.push(
      `Deals:\n${deals
        .map((d) => {
          const bits = [
            d.minimumOrderValue !== undefined ? `min ${money(d.minimumOrderValue, market)}` : null,
            d.maximumDiscountAmount !== undefined ? `capped at ${money(d.maximumDiscountAmount, market)}` : null,
            d.isProOnly ? 'pandapro only' : null,
            d.isNewCustomerOnly ? 'new customers only' : null,
          ].filter(Boolean);
          return `- ${d.title}${d.description && d.description !== d.title ? ` — ${d.description}` : ''}` +
            (bits.length ? `\n  (${bits.join(', ')})` : '');
        })
        .join('\n')}`,
    );
  }

  if (discounts.length) {
    parts.push(
      `Discounts:\n${discounts
        .map((d) => {
          const bits = [
            d.percentage !== undefined ? `${d.percentage}%` : null,
            d.amount !== undefined && d.amount > 0 ? money(d.amount, market) : null,
            d.minimumOrderValue !== undefined ? `min ${money(d.minimumOrderValue, market)}` : null,
            d.maximumDiscountAmount !== undefined ? `capped at ${money(d.maximumDiscountAmount, market)}` : null,
          ].filter(Boolean);
          return `- ${d.description}${bits.length ? ` (${bits.join(', ')})` : ''}`;
        })
        .join('\n')}`,
    );
  }

  return parts.length ? `\n${parts.join('\n\n')}\n` : '';
}
