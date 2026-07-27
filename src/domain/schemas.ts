import { z } from 'zod';

/**
 * Runtime validation of UPSTREAM responses.
 *
 * Design rule: these schemas are deliberately permissive. Everything that is
 * not strictly required to build a useful answer is `.optional()`, `.nullish()`
 * or `.catch()`. The goal is not to police the upstream payload — it is to
 * guarantee that a field appearing, disappearing or changing type degrades one
 * value rather than throwing and taking down the whole tool call.
 *
 * `.passthrough()` keeps unknown keys so nothing is silently lost.
 */

const num = z.coerce.number().nullish().catch(undefined);
const str = z.coerce.string().nullish().catch(undefined);
const bool = z.coerce.boolean().nullish().catch(undefined);

export const UpstreamCuisineSchema = z
  .object({
    id: num,
    name: str,
    title: str,
    slug: str,
    count: num,
    main: bool,
  })
  .passthrough();

export const UpstreamDiscountSchema = z
  .object({
    type: str,
    description: str,
    discount_type: str,
    discount_amount: num,
    value: num,
    minimum_order_value: num,
    maximum_discount_amount: num,
    discount_text: str,
    banner_title: str,
  })
  .passthrough();

export const UpstreamDealSchema = z
  .object({
    title: str,
    description: str,
    type: str,
    offer_type: str,
    minimum_order_value: num,
    maximum_discount_amount: num,
    value: num,
    is_pro: bool,
    is_new_customer: bool,
  })
  .passthrough();

export const UpstreamScheduleSchema = z
  .object({
    weekday: num,
    opening_type: str,
    opening_time: str,
    closing_time: str,
  })
  .passthrough();

/** A vendor as it appears in the disco listing response. */
export const UpstreamVendorSchema = z
  .object({
    id: num,
    code: str,
    name: str,
    rating: num,
    review_number: num,
    cuisines: z.array(UpstreamCuisineSchema).nullish().catch(undefined),
    primary_cuisine_id: num,
    address: str,
    city: z.union([z.string(), z.object({ name: str }).passthrough()]).nullish().catch(undefined),
    latitude: num,
    longitude: num,
    distance: num,
    minimum_order_amount: num,
    minimum_delivery_fee: num,
    minimum_delivery_time: num,
    budget: num,
    is_delivery_enabled: bool,
    is_pickup_enabled: bool,
    has_online_payment: bool,
    is_promoted: bool,
    is_new: bool,
    discounts: z.array(UpstreamDiscountSchema).nullish().catch(undefined),
    web_path: str,
    url_key: str,
    vertical: str,
    redirection_url: str,
  })
  .passthrough();

export const UpstreamListingSchema = z
  .object({
    status_code: num,
    message: str,
    data: z
      .object({
        available_count: num,
        returned_count: num,
        items: z.array(UpstreamVendorSchema).nullish().catch(undefined),
        aggregations: z
          .object({
            cuisines: z.array(UpstreamCuisineSchema).nullish().catch(undefined),
            quickFilters: z.array(UpstreamCuisineSchema).nullish().catch(undefined),
            foodCharacteristics: z.array(UpstreamCuisineSchema).nullish().catch(undefined),
          })
          .passthrough()
          .nullish()
          .catch(undefined),
      })
      .passthrough(),
  })
  .passthrough();

export const UpstreamProductVariationSchema = z
  .object({
    id: num,
    name: str,
    price: num,
    price_before_discount: num,
    is_vegetarian: bool,
  })
  .passthrough();

export const UpstreamProductSchema = z
  .object({
    id: num,
    name: str,
    description: str,
    is_sold_out: bool,
    file_path: str,
    product_variations: z.array(UpstreamProductVariationSchema).nullish().catch(undefined),
  })
  .passthrough();

export const UpstreamMenuCategorySchema = z
  .object({
    id: num,
    name: str,
    description: str,
    is_popular_category: bool,
    products: z.array(UpstreamProductSchema).nullish().catch(undefined),
  })
  .passthrough();

export const UpstreamMenuSchema = z
  .object({
    id: num,
    name: str,
    type: str,
    menu_categories: z.array(UpstreamMenuCategorySchema).nullish().catch(undefined),
  })
  .passthrough();

/** A vendor as it appears in the per-country detail response. */
export const UpstreamVendorDetailSchema = z
  .object({
    status_code: num,
    data: UpstreamVendorSchema.extend({
      menus: z.array(UpstreamMenuSchema).nullish().catch(undefined),
      schedules: z.array(UpstreamScheduleSchema).nullish().catch(undefined),
      deals: z.array(UpstreamDealSchema).nullish().catch(undefined),
      delivery_duration_range: z
        .object({ lower_limit_in_minutes: num, upper_limit_in_minutes: num })
        .passthrough()
        .nullish()
        .catch(undefined),
    }).passthrough(),
  })
  .passthrough();

export const UpstreamConfigurationSchema = z
  .object({
    data: z
      .object({
        global_entity_id: str,
        currency_symbol: str,
        currency_symbol_position: str,
        timezone: str,
        number_of_decimal_digits: num,
        country_code_mobile: str,
      })
      .passthrough(),
  })
  .passthrough();

export const NominatimResultSchema = z
  .object({
    lat: z.coerce.number(),
    lon: z.coerce.number(),
    display_name: z.string(),
    address: z.object({ country_code: str }).passthrough().nullish().catch(undefined),
  })
  .passthrough();

export const NominatimSearchSchema = z.array(NominatimResultSchema);

export type UpstreamVendor = z.infer<typeof UpstreamVendorSchema>;
export type UpstreamListing = z.infer<typeof UpstreamListingSchema>;
export type UpstreamVendorDetail = z.infer<typeof UpstreamVendorDetailSchema>;
export type UpstreamConfiguration = z.infer<typeof UpstreamConfigurationSchema>;

/**
 * Validate without ever throwing.
 *
 * Returns the parsed value on success. On failure it returns the RAW value cast
 * to the target type and a warning string. Callers surface the warning through
 * ToolMeta.degraded so the user is told the data may be incomplete, instead of
 * the tool call failing outright. This is the graceful-degradation contract.
 */
export function safeValidate<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): { value: T; warning?: string } {
  const result = schema.safeParse(value);
  if (result.success) return { value: result.data };
  const issue = result.error.issues[0];
  const where = issue?.path?.join('.') || '(root)';
  return {
    value: value as T,
    warning: `Upstream response for ${label} did not match the expected shape at "${where}" (${
      issue?.message ?? 'unknown issue'
    }). Returning best-effort data; some fields may be missing.`,
  };
}
