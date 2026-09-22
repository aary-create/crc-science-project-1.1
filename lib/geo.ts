// Straight-line distance in km between two lat/lng points.
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Ray casting on a [lat, lng] ring. Accurate enough at district scale.
export function pointInPolygon(lat: number, lng: number, ring: [number, number][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// India runs on one clock (IST, UTC+05:30, no DST), so hour-of-day logic is
// computed in IST explicitly — the server itself runs in UTC on Vercel.
export function istHour(at: Date = new Date()) {
  return new Date(at.getTime() + 330 * 60_000).getUTCHours();
}

// Heat advisories are about the 11am–4pm peak. "Night" here is 8pm–7am IST.
export function isNightIST(at: Date = new Date()) {
  const h = istHour(at);
  return h >= 20 || h < 7;
}
