import type { HttpClient } from '../http/client.js';
import type { Config } from '../config.js';
import { NominatimSearchSchema, NominatimResultSchema, safeValidate } from '../domain/schemas.js';
import { guessMarketFromCoordinates, isSupportedMarket } from '../domain/markets.js';
import type { ResolvedLocation } from '../domain/types.js';

/**
 * Address -> coordinates.
 *
 * foodpanda has no public geocoding endpoint — every /api/v5/locations/* path
 * probed during research returned 404. The website uses a keyed Google Places
 * integration we cannot and should not reuse.
 *
 * OpenStreetMap Nominatim is used instead: free, no API key, and therefore
 * consistent with the project's zero-key promise. Its usage policy requires an
 * identifying User-Agent and at most ~1 request/second, both of which are
 * honoured (results are cached for a week by default, since addresses are static).
 */
const NOMINATIM = 'https://nominatim.openstreetmap.org';

export class GeocoderDisabledError extends Error {
  constructor() {
    super(
      'Address lookup is disabled (GEOCODER_ENABLED=false). Pass explicit latitude and longitude instead.',
    );
    this.name = 'GeocoderDisabledError';
  }
}

export class GeocodeAdapter {
  constructor(
    private readonly http: HttpClient,
    private readonly config: Config,
  ) {}

  private headers(): Record<string, string> {
    return {
      'user-agent': this.config.geocoderUserAgent,
      // Without this, place names come back in the local script (e.g. Urdu for
      // Karachi), which is unhelpful in an English-language tool response.
      'accept-language': 'en',
    };
  }

  async forward(query: string, limit = 3): Promise<ResolvedLocation[]> {
    if (!this.config.geocoderEnabled) throw new GeocoderDisabledError();

    const q = new URLSearchParams({
      q: query,
      format: 'jsonv2',
      limit: String(Math.min(Math.max(limit, 1), 10)),
      addressdetails: '1',
    });
    const raw = await this.http.getJson(`${NOMINATIM}/search?${q.toString()}`, {
      headers: this.headers(),
      ttlSeconds: this.config.ttl.geocode,
    });

    const { value } = safeValidate(NominatimSearchSchema, raw, 'geocoder search');
    const rows = Array.isArray(value) ? value : [];

    return rows.map((r: any) => this.toResolved(r, 'geocoder'));
  }

  async reverse(latitude: number, longitude: number): Promise<ResolvedLocation> {
    if (!this.config.geocoderEnabled) {
      // Coordinates alone are still perfectly usable; degrade instead of failing.
      return this.fromCoordinates(latitude, longitude);
    }
    const q = new URLSearchParams({
      lat: String(latitude),
      lon: String(longitude),
      format: 'jsonv2',
    });
    try {
      const raw = await this.http.getJson(`${NOMINATIM}/reverse?${q.toString()}`, {
        headers: this.headers(),
        ttlSeconds: this.config.ttl.geocode,
      });
      const { value } = safeValidate(NominatimResultSchema, raw, 'geocoder reverse');
      return this.toResolved(value, 'geocoder');
    } catch {
      return this.fromCoordinates(latitude, longitude);
    }
  }

  /** Build a location from raw coordinates with no network call. */
  fromCoordinates(latitude: number, longitude: number): ResolvedLocation {
    const market = guessMarketFromCoordinates(latitude, longitude);
    const out: ResolvedLocation = {
      latitude,
      longitude,
      displayName: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
      marketSupported: market !== undefined && isSupportedMarket(market),
      source: 'coordinates',
    };
    if (market) out.market = market;
    return out;
  }

  private toResolved(r: any, source: 'coordinates' | 'geocoder'): ResolvedLocation {
    const latitude = Number(r?.lat);
    const longitude = Number(r?.lon);
    const cc = r?.address?.country_code ? String(r.address.country_code).toLowerCase() : undefined;
    // Trust the geocoder's country code when present; fall back to a bounding-box guess.
    const market = cc && isSupportedMarket(cc) ? cc : guessMarketFromCoordinates(latitude, longitude);

    const out: ResolvedLocation = {
      latitude,
      longitude,
      displayName: String(r?.display_name ?? `${latitude}, ${longitude}`),
      marketSupported: market !== undefined && isSupportedMarket(market),
      source,
    };
    if (cc) out.countryCode = cc;
    if (market) out.market = market;
    return out;
  }
}
