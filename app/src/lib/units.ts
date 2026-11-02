const KM_PER_MI = 1.609344;
const FT_PER_M = 3.28084;

/** 0.62 km → "0.4 mi". null stays null (no location → no distance shown). */
export function formatMiles(km: number | null | undefined): string | null {
  if (km == null) return null;
  const mi = Number(km) / KM_PER_MI;
  if (mi < 0.1) return '< 0.1 mi';
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

/** Short distances (check-ins, GPS accuracy) in feet; switches to miles past ~1,000 ft. */
export function formatFeet(m: number): string {
  const ft = m * FT_PER_M;
  if (ft < 1000) return `${Math.max(10, Math.round(ft / 10) * 10)} ft`;
  return `${(m / 1000 / KM_PER_MI).toFixed(1)} mi`;
}

/** The notification radius is stored in km; the app shows and steps it in whole miles. */
export const kmToMi = (km: number) => Math.max(1, Math.round(km / KM_PER_MI));
export const miToKm = (mi: number) => Math.min(50, Math.max(1, Math.round(mi * KM_PER_MI)));
