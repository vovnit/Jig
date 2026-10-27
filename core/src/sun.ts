// The sun's position and the day's sun times, from the NOAA solar
// calculations (the same low-precision algorithm as their solar calculator).
// Pure math with no host calls, so it runs in every engine we ship.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

const norm360 = (d: number): number => ((d % 360) + 360) % 360;
const julianDay = (ms: number): number => ms / 86400000 + 2440587.5;

// Declination (degrees) and equation of time (minutes) for a Julian day.
function coords(jd: number): { decl: number; eqTime: number } {
  const t = (jd - 2451545) / 36525;
  const l0 = norm360(280.46646 + 36000.76983 * t + 0.0003032 * t * t);
  const m = norm360(357.52911 + 35999.05029 * t - 0.0001537 * t * t);
  const e = 0.016708634 - 0.000042037 * t - 0.0000001267 * t * t;
  const mr = m * RAD;
  const c =
    Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mr) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mr) * 0.000289;
  const appLong = l0 + c - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos((125.04 - 1934.136 * t) * RAD)) * RAD;
  const decl = Math.asin(Math.sin(eps) * Math.sin(appLong * RAD)) * DEG;
  const l0r = l0 * RAD;
  const y = Math.tan(eps / 2) ** 2;
  const eqTime =
    4 * DEG *
    (y * Math.sin(2 * l0r) -
      2 * e * Math.sin(mr) +
      4 * e * y * Math.sin(mr) * Math.cos(2 * l0r) -
      0.5 * y * y * Math.sin(4 * l0r) -
      1.25 * e * e * Math.sin(2 * mr));
  return { decl, eqTime };
}

/** Place's sun position at a moment: azimuth clockwise from north, altitude above the horizon. */
export function sunPosition(lat: number, lon: number, ms: number): { azimuth: number; altitude: number } {
  const { decl, eqTime } = coords(julianDay(ms));
  const mins = (((ms / 60000) % 1440) + 1440) % 1440;
  const tst = (((mins + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = (tst / 4 - 180) * RAD;
  const latR = lat * RAD;
  const declR = decl * RAD;
  const cosZen = Math.sin(latR) * Math.sin(declR) + Math.cos(latR) * Math.cos(declR) * Math.cos(ha);
  const altitude = 90 - Math.acos(Math.min(1, Math.max(-1, cosZen))) * DEG;
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(latR) - Math.tan(declR) * Math.cos(latR)) * DEG + 180;
  return { azimuth: norm360(az), altitude };
}

export interface SunTimes {
  sunrise: number | null;
  sunset: number | null;
  noon: number;
  dawn: number | null;
  dusk: number | null;
}

/** A UTC day's sun times in epoch milliseconds; null where the sun never crosses that altitude. */
// A day the sun crosses only once keeps the symmetric noon estimate (left as is).
export function sunTimes(lat: number, lon: number, dayStartUtcMs: number): SunTimes {
  // Solar noon in minutes after UTC midnight, refined once at noon itself.
  const rough = 720 - 4 * lon - coords(julianDay(dayStartUtcMs)).eqTime;
  const { decl, eqTime } = coords(julianDay(dayStartUtcMs + rough * 60000));
  const noon = dayStartUtcMs + (720 - 4 * lon - eqTime) * 60000;
  const latR = lat * RAD;
  const declR = decl * RAD;
  // Half the time the sun spends above `alt`, in milliseconds (null if it never crosses).
  const halfDay = (alt: number): number | null => {
    const cosH = (Math.sin(alt * RAD) - Math.sin(latR) * Math.sin(declR)) / (Math.cos(latR) * Math.cos(declR));
    if (!(cosH < 1) || !(cosH > -1)) return null;
    return Math.acos(cosH) * DEG * 4 * 60000;
  };
  const day = halfDay(-0.833);
  const civil = halfDay(-6);
  return {
    sunrise: day == null ? null : Math.round(noon - day),
    sunset: day == null ? null : Math.round(noon + day),
    noon: Math.round(noon),
    dawn: civil == null ? null : Math.round(noon - civil),
    dusk: civil == null ? null : Math.round(noon + civil),
  };
}
