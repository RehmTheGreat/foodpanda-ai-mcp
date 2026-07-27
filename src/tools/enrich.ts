import type { ToolContext } from './context.js';
import type { Restaurant } from '../domain/types.js';

/**
 * Populate open/closed status on restaurants that came from the listing endpoint.
 *
 * WHY THIS EXISTS: the disco listing response contains no `schedules` field at
 * all (verified: 0 of 50 vendors carried one). Opening hours only exist on the
 * per-vendor detail endpoint. So "open now" cannot be answered from a listing —
 * it requires one extra request per restaurant.
 *
 * That cost is real, so enrichment is bounded by `budget` and only ever applied
 * to the candidates most likely to be returned. Restaurants beyond the budget
 * keep `openStatus === undefined`, which callers must treat as "unknown" rather
 * than "closed".
 */
export async function enrichWithOpenStatus(
  ctx: ToolContext,
  restaurants: Restaurant[],
  market: string,
  budget: number,
): Promise<{ enriched: Restaurant[]; checked: number; warnings: string[] }> {
  const targets = restaurants.slice(0, Math.max(0, budget));
  const warnings: string[] = [];

  const byCode = new Map<string, Restaurant>();
  await Promise.all(
    targets.map(async (r) => {
      try {
        const { restaurant } = await ctx.foodpanda.getVendorDetail(r.code, market);
        // Keep the listing record (it has distance, which detail lacks) and
        // graft on only the schedule-derived fields.
        const merged: Restaurant = { ...r };
        if (restaurant.schedules) merged.schedules = restaurant.schedules;
        if (restaurant.openStatus) merged.openStatus = restaurant.openStatus;
        byCode.set(r.code, merged);
      } catch (err) {
        ctx.logger.debug('open-status enrichment failed', {
          code: r.code,
          error: err instanceof Error ? err.message : String(err),
        });
        warnings.push(`Could not determine opening hours for ${r.name} (${r.code}).`);
      }
    }),
  );

  if (restaurants.length > targets.length) {
    warnings.push(
      `Opening hours were checked for the first ${targets.length} of ${restaurants.length} candidates ` +
        `(each check is a separate request). Raise openNowCheckLimit for wider coverage.`,
    );
  }

  return {
    enriched: restaurants.map((r) => byCode.get(r.code) ?? r),
    checked: targets.length,
    warnings,
  };
}

/** Keep only restaurants confirmed open. Unknown status is excluded, not assumed. */
export function keepOpen(restaurants: Restaurant[]): Restaurant[] {
  return restaurants.filter((r) => r.openStatus?.isOpen === true);
}
