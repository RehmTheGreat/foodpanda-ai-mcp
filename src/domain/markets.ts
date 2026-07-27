import type { Market } from './types.js';

/**
 * Markets verified live on 2026-07-27 (see docs/API-RESEARCH.md for the matrix).
 *
 * Every entry here returned HTTP 200 with real vendors from the disco listing
 * endpoint AND a working per-country menu host. Currency/timezone values come
 * from each market's own /api/v5/configuration response, not from assumption.
 *
 * Thailand (th) is deliberately absent: th.fd-api.com returned Cloudflare
 * "Error 1016: Origin DNS error" on every attempt. It is listed as `KNOWN_ABSENT`
 * so the failure is documented rather than silently missing.
 */
export const MARKETS: Record<string, Market> = {
  pk: {
    code: 'pk',
    name: 'Pakistan',
    globalEntityId: 'FP_PK',
    currencySymbol: 'Rs.',
    currencyPosition: 'left',
    timezone: 'Asia/Karachi',
    decimalDigits: 0,
  },
  bd: {
    code: 'bd',
    name: 'Bangladesh',
    globalEntityId: 'FP_BD',
    currencySymbol: 'Tk',
    currencyPosition: 'left',
    timezone: 'Asia/Dhaka',
    decimalDigits: 0,
  },
  my: {
    code: 'my',
    name: 'Malaysia',
    globalEntityId: 'FP_MY',
    currencySymbol: 'RM',
    currencyPosition: 'left',
    timezone: 'Asia/Kuala_Lumpur',
    decimalDigits: 2,
  },
  sg: {
    code: 'sg',
    name: 'Singapore',
    globalEntityId: 'FP_SG',
    currencySymbol: 'S$',
    currencyPosition: 'left',
    timezone: 'Asia/Singapore',
    decimalDigits: 2,
  },
  ph: {
    code: 'ph',
    name: 'Philippines',
    globalEntityId: 'FP_PH',
    currencySymbol: '₱',
    currencyPosition: 'left',
    timezone: 'Asia/Manila',
    decimalDigits: 2,
  },
  tw: {
    code: 'tw',
    name: 'Taiwan',
    globalEntityId: 'FP_TW',
    currencySymbol: '$',
    currencyPosition: 'left',
    timezone: 'Asia/Taipei',
    decimalDigits: 0,
  },
  hk: {
    code: 'hk',
    name: 'Hong Kong',
    globalEntityId: 'FP_HK',
    currencySymbol: 'HK$',
    currencyPosition: 'left',
    timezone: 'Asia/Hong_Kong',
    decimalDigits: 1,
  },
  kh: {
    code: 'kh',
    name: 'Cambodia',
    globalEntityId: 'FP_KH',
    currencySymbol: '$',
    currencyPosition: 'left',
    timezone: 'Asia/Phnom_Penh',
    decimalDigits: 2,
  },
  la: {
    code: 'la',
    name: 'Laos',
    globalEntityId: 'FP_LA',
    currencySymbol: '₭',
    currencyPosition: 'left',
    timezone: 'Asia/Vientiane',
    decimalDigits: 0,
  },
  mm: {
    code: 'mm',
    name: 'Myanmar',
    globalEntityId: 'FP_MM',
    currencySymbol: 'MMK',
    currencyPosition: 'left',
    timezone: 'Asia/Yangon',
    decimalDigits: 0,
  },
};

/** Markets that exist as foodpanda brands but failed live verification. */
export const KNOWN_ABSENT: Record<string, string> = {
  th: 'th.fd-api.com returns Cloudflare "Error 1016: Origin DNS error"; the market host did not resolve during verification on 2026-07-27.',
};

export const MARKET_CODES = Object.keys(MARKETS);

export function isSupportedMarket(code: string): boolean {
  return Object.hasOwn(MARKETS, code.toLowerCase());
}

export function getMarket(code: string): Market | undefined {
  return MARKETS[code.toLowerCase()];
}

/**
 * Rough bounding boxes, used only to guess a market from coordinates when the
 * caller did not name one. Intentionally coarse: a wrong guess is corrected by
 * the caller passing `market` explicitly, and every tool says which market it used.
 */
const BOXES: Array<{ market: string; minLat: number; maxLat: number; minLng: number; maxLng: number }> = [
  { market: 'pk', minLat: 23.5, maxLat: 37.1, minLng: 60.8, maxLng: 77.9 },
  { market: 'bd', minLat: 20.5, maxLat: 26.7, minLng: 88.0, maxLng: 92.7 },
  { market: 'my', minLat: 0.8, maxLat: 7.4, minLng: 99.6, maxLng: 119.3 },
  { market: 'sg', minLat: 1.15, maxLat: 1.48, minLng: 103.6, maxLng: 104.1 },
  { market: 'ph', minLat: 4.5, maxLat: 21.2, minLng: 116.9, maxLng: 126.6 },
  { market: 'tw', minLat: 21.9, maxLat: 25.3, minLng: 119.3, maxLng: 122.1 },
  { market: 'hk', minLat: 22.15, maxLat: 22.58, minLng: 113.8, maxLng: 114.44 },
  { market: 'kh', minLat: 10.3, maxLat: 14.7, minLng: 102.3, maxLng: 107.6 },
  { market: 'la', minLat: 13.9, maxLat: 22.5, minLng: 100.0, maxLng: 107.7 },
  { market: 'mm', minLat: 9.5, maxLat: 28.5, minLng: 92.2, maxLng: 101.2 },
];

export function guessMarketFromCoordinates(latitude: number, longitude: number): string | undefined {
  // Singapore and Hong Kong are inside larger neighbours' boxes, so check the
  // smallest boxes first by sorting on area.
  const ranked = [...BOXES].sort(
    (a, b) =>
      (a.maxLat - a.minLat) * (a.maxLng - a.minLng) - (b.maxLat - b.minLat) * (b.maxLng - b.minLng),
  );
  for (const b of ranked) {
    if (latitude >= b.minLat && latitude <= b.maxLat && longitude >= b.minLng && longitude <= b.maxLng) {
      return b.market;
    }
  }
  return undefined;
}
