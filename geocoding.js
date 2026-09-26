// ---------- Location Foundation V1: geocoding abstraction ----------
// Single place responsible for turning free-text location strings into coordinates. Nothing else
// in the app should call a mapping provider's API directly — this keeps provider-swapping to a
// change in this one file, mirroring the existing moderateImage()-is-the-only-caller pattern
// already used for image moderation in server.js.
//
// Provider: Geoapify Geocoding API (v1). Credential: GEOAPIFY_KEY env var (server-side only —
// never sent to the frontend, never included in any API response).
//
// Provider history: this app previously used Mapbox Geocoding v5. That was replaced with Geoapify
// because Geoapify's free plan (3,000 credits/day, no credit card) explicitly permits storing
// geocoding results, whereas Mapbox's free/temporary tier does not — see the "Mapbox storage
// compliance audit" and "Free-first location architecture audit" that preceded this change. A
// future switch to Mapbox, Google, or a self-hosted provider only ever requires changes inside
// this one file — the provider abstraction itself is the migration hook, so there is no need to
// keep an unused credential variable around for a provider that isn't in use.
//
// Fails safe by design: every function here returns a plain status object and NEVER throws. A
// missing key, a network timeout, a malformed provider response, or a rate limit all result in a
// { status: '...', lat: null, lng: null } object rather than an exception — callers (server.js) can
// always safely `await` this without a try/catch and without risking breaking the request that
// triggered it. This matters because geocoding is explicitly a non-blocking, best-effort background
// enrichment step (see server.js) — it must never be able to fail a signup, a post, or an edit.

const GEOAPIFY_KEY = process.env.GEOAPIFY_KEY || '';
const GEOCODE_TIMEOUT_MS = 5000;
// Smallest sensible floor to avoid burning a provider credit on a single keystroke before the
// frontend's existing 350ms debounce has anything meaningful to search for. The original Mapbox
// implementation had no such floor (only a blank-string check); this is a minimal addition, kept
// entirely inside this file so server.js/app.js require no changes.
const MIN_SEARCH_LENGTH = 2;

function isGeocodingConfigured() {
  return !!GEOAPIFY_KEY;
}

function isValidLat(lat) {
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
}
function isValidLng(lng) {
  return typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

// Deterministic coordinate rounding — NOT random jitter. Random jitter would need to be stored to
// stay consistent across requests (defeating the "don't store more than necessary" goal) or would
// visibly jump around between renders if re-randomized. Rounding to `decimals` places snaps the
// point to a fixed grid: ~1.1km at 2 decimals, ~11km at 1 decimal, near the equator (less at higher
// latitudes for longitude). This is intentionally coarse enough that the real address cannot be
// recovered from the public value, while still being useful for a future "sort by distance" feature.
function fuzzCoordinate(lat, lng, decimals = 2) {
  if (!isValidLat(lat) || !isValidLng(lng)) return { lat: null, lng: null };
  const factor = Math.pow(10, decimals);
  return { lat: Math.round(lat * factor) / factor, lng: Math.round(lng * factor) / factor };
}

// Extracts the first usable feature from a Geoapify GeoJSON FeatureCollection response, or null.
// Geoapify's default (geojson) response shape is { features: [ { properties: { lat, lon,
// formatted, result_type, ... }, geometry: {...} } ] } — coordinates live under `properties`,
// already as plain numbers (not a [lng,lat] pair the way Mapbox's `center` was).
function firstFeature(data) {
  if (!data || !Array.isArray(data.features) || !data.features.length) return null;
  const f = data.features[0];
  return f && f.properties ? f : null;
}

// Maps a Geoapify `result_type` value to one of the three precision levels this app ever assigns
// to a USER's general discovery location. 'exact' is deliberately never returned here — that
// concept is reserved for item/request pickup coordinates geocoded from a specific street address,
// a different thing entirely from where a person generally is for discovery purposes.
function precisionFromResultType(resultType) {
  const t = typeof resultType === 'string' ? resultType : '';
  if (t === 'suburb' || t === 'district') return 'neighborhood';
  if (t === 'city' || t === 'county' || t === 'state') return 'city';
  return 'approximate';
}

// Forward geocode: free text -> { status, lat, lng }.
// status is one of: 'ok' | 'skipped' (blank input) | 'not_configured' (no GEOAPIFY_KEY) |
// 'not_found' (provider returned zero results) | 'rate_limited' (HTTP 429) | 'timeout' |
// 'failed' (any other error/non-2xx/malformed response).
async function geocodeText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { status: 'skipped', lat: null, lng: null };
  if (!isGeocodingConfigured()) return { status: 'not_configured', lat: null, lng: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const url = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(trimmed)}&limit=1&apiKey=${encodeURIComponent(GEOAPIFY_KEY)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429) return { status: 'rate_limited', lat: null, lng: null };
    if (!res.ok) return { status: 'failed', lat: null, lng: null };
    const data = await res.json();
    const feature = firstFeature(data);
    if (!feature) return { status: 'not_found', lat: null, lng: null };
    const lat = feature.properties.lat, lng = feature.properties.lon;
    if (!isValidLat(lat) || !isValidLng(lng)) return { status: 'failed', lat: null, lng: null };
    return { status: 'ok', lat, lng };
  } catch (err) {
    return { status: err && err.name === 'AbortError' ? 'timeout' : 'failed', lat: null, lng: null };
  } finally {
    clearTimeout(timer);
  }
}

// Reverse geocode: coordinates -> a single human-readable label (e.g. "Hyderabad, Telangana").
// status: 'ok' | 'invalid_coordinates' | 'not_configured' | 'not_found' | 'rate_limited' |
// 'timeout' | 'failed'.
async function reverseGeocode(lat, lng) {
  if (!isValidLat(lat) || !isValidLng(lng)) return { status: 'invalid_coordinates', label: null, precision: null };
  if (!isGeocodingConfigured()) return { status: 'not_configured', label: null, precision: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const url = `https://api.geoapify.com/v1/geocode/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&limit=1&apiKey=${encodeURIComponent(GEOAPIFY_KEY)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429) return { status: 'rate_limited', label: null, precision: null };
    if (!res.ok) return { status: 'failed', label: null, precision: null };
    const data = await res.json();
    const feature = firstFeature(data);
    if (!feature || typeof feature.properties.formatted !== 'string' || !feature.properties.formatted.trim()) {
      return { status: 'not_found', label: null, precision: null };
    }
    return { status: 'ok', label: feature.properties.formatted, precision: precisionFromResultType(feature.properties.result_type) };
  } catch (err) {
    return { status: err && err.name === 'AbortError' ? 'timeout' : 'failed', label: null, precision: null };
  } finally {
    clearTimeout(timer);
  }
}

// Forward search/autocomplete: free text -> up to 5 human-readable candidates, each with
// coordinates and a suggested precision (derived server-side from the provider's own place
// classification, never from anything the client asserts). status: 'ok' | 'skipped' |
// 'not_configured' | 'not_found' | 'rate_limited' | 'timeout' | 'failed'.
//
// These results are TEMPORARY suggestions only (Geoapify's autocomplete endpoint, used purely for
// the live "type and see suggestions" list). They must never be written to the database directly —
// once the user confirms a selection, the caller re-resolves that selection's label through
// geocodeText() (a fresh, persistence-appropriate call) before saving. See server.js's PATCH
// /api/me and pickup-address handling for where that re-resolution happens.
async function searchPlaces(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { status: 'skipped', results: [] };
  if (trimmed.length < MIN_SEARCH_LENGTH) return { status: 'skipped', results: [] };
  if (!isGeocodingConfigured()) return { status: 'not_configured', results: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const url = `https://api.geoapify.com/v1/geocode/autocomplete?text=${encodeURIComponent(trimmed)}&limit=5&apiKey=${encodeURIComponent(GEOAPIFY_KEY)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429) return { status: 'rate_limited', results: [] };
    if (!res.ok) return { status: 'failed', results: [] };
    const data = await res.json();
    const features = data && Array.isArray(data.features) ? data.features : [];
    const results = features
      .filter(f => f && f.properties && typeof f.properties.formatted === 'string')
      .map(f => ({
        label: f.properties.formatted,
        lat: f.properties.lat,
        lng: f.properties.lon,
        precision: precisionFromResultType(f.properties.result_type)
      }))
      .filter(r => isValidLat(r.lat) && isValidLng(r.lng));
    if (!results.length) return { status: 'not_found', results: [] };
    return { status: 'ok', results };
  } catch (err) {
    return { status: err && err.name === 'AbortError' ? 'timeout' : 'failed', results: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { geocodeText, reverseGeocode, searchPlaces, isGeocodingConfigured, isValidLat, isValidLng, fuzzCoordinate };
