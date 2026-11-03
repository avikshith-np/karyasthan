// T007 — travel math (src/life/travel.js): haversine, peak/off-peak, weekend
// factor, rain → cab, walk threshold, zero trips, timezone handling.
import { section, check, eq, near, throws, report, PROJECT_ROOT } from './_helpers.js';
import fs from 'fs';
import path from 'path';
import {
  haversineKm, peakFactor, chooseMode, travelCost, planTrip, travelMinutes, lerpPosition, hhmmToMinutes,
} from '../../src/life/travel.js';

const KM_PER_DEG = (Math.PI / 180) * 6371; // ≈ 111.195 km per degree on a great circle

// UTC world so "at" hours read directly. 2026-10-27 is a Tuesday.
const world = {
  timezone: 'UTC',
  routine: { weekend: [0, 6] },
  places: [
    { id: 'place:a', name: 'A', kind: 'home', lat: 0, lon: 0 },
    { id: 'place:b', name: 'B', kind: 'office', lat: 0.1, lon: 0 },        // ≈ 11.12 km north
    { id: 'place:near', name: 'Near', kind: 'cafe', lat: 0.009, lon: 0 },  // ≈ 1.00 km
    { id: 'place:edge', name: 'Edge', kind: 'shop', lat: 0.0117, lon: 0 }, // ≈ 1.30 km
  ],
  travel: {
    roadFactor: 1.35,
    speedsKmh: { walk: 4.5, scooter: 22, cab: 20 },
    overheadMin: { walk: 0, scooter: 5, cab: 8 },
    peakWindows: [
      { from: '08:30', to: '10:30', factor: 1.6 },
      { from: '09:00', to: '09:30', factor: 1.9 }, // overlaps → max wins
      { from: '22:00', to: '02:00', factor: 1.3 }, // wraps midnight
    ],
    weekendFactor: 1.2,
    walkMaxKm: 1.2,
    defaultMode: 'scooter',
    costPerKm: { walk: 0, scooter: 2, cab: 15 },
  },
};
const utc = (d, h, m = 0) => Date.UTC(2026, 9, d, h, m) / 1000; // October 2026
const TUE = 27; const SUN = 25;
const expectMin = (km, mode, factor) =>
  Math.round(world.travel.overheadMin[mode] + ((km * world.travel.roadFactor) / world.travel.speedsKmh[mode]) * 60 * factor);

section('haversine');
near('1° of latitude', haversineKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), KM_PER_DEG, 1e-6);
near('1° of longitude on the equator', haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), KM_PER_DEG, 1e-6);
near('1° of longitude at 60° is about half', haversineKm({ lat: 60, lon: 0 }, { lat: 60, lon: 1 }), KM_PER_DEG / 2, 0.01);
near('symmetric', haversineKm({ lat: 12.3, lon: 45.6 }, { lat: 12.4, lon: 45.5 }),
  haversineKm({ lat: 12.4, lon: 45.5 }, { lat: 12.3, lon: 45.6 }), 1e-9);
eq('same point → 0', haversineKm({ lat: 5, lon: 5 }, { lat: 5, lon: 5 }), 0);
near('antipodes ≈ half the circumference', haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 }), Math.PI * 6371, 1e-6);

section('peak factor');
eq('hhmm parse', hhmmToMinutes('08:30'), 510);
check('hhmm malformed → NaN', Number.isNaN(hhmmToMinutes('8h30')));
eq('Tue 07:00 off-peak', peakFactor(utc(TUE, 7), world), 1);
eq('Tue 08:30 window start is inclusive', peakFactor(utc(TUE, 8, 30), world), 1.6);
eq('Tue 09:15 overlapping windows → max', peakFactor(utc(TUE, 9, 15), world), 1.9);
eq('Tue 10:30 window end is exclusive', peakFactor(utc(TUE, 10, 30), world), 1);
eq('Tue 23:00 wrap-around window', peakFactor(utc(TUE, 23), world), 1.3);
eq('Wed 01:30 wrap-around window after midnight', peakFactor(utc(TUE + 1, 1, 30), world), 1.3);
eq('Sun 09:15 → weekendFactor, not the peak', peakFactor(utc(SUN, 9, 15), world), 1.2);
eq('weekendFactor defaults to 1', peakFactor(utc(SUN, 9, 15), { ...world, travel: { ...world.travel, weekendFactor: undefined } }), 1);
eq('weekend days come from routine.weekend', peakFactor(utc(TUE, 9, 15), { ...world, routine: { weekend: [2] } }), 1.2);
eq('world timezone: 00:15 UTC is 09:15 in UTC+9', peakFactor(utc(TUE, 0, 15), { ...world, timezone: 'Asia/Tokyo' }), 1.9);
eq('no peak windows → 1', peakFactor(utc(TUE, 9), { ...world, travel: { ...world.travel, peakWindows: [] } }), 1);

section('mode choice');
const kmNear = haversineKm(world.places[0], world.places[2]);
const kmEdge = haversineKm(world.places[0], world.places[3]);
check('fixture distances straddle walkMaxKm', kmNear < 1.2 && kmEdge > 1.2, { kmNear, kmEdge });
eq('≤ walkMaxKm dry → walk', chooseMode(kmNear, null, world), 'walk');
eq('exactly walkMaxKm → walk', chooseMode(1.2, { rain: false }, world), 'walk');
eq('> walkMaxKm dry → default mode', chooseMode(kmEdge, { rain: false }, world), 'scooter');
eq('rain → cab (long trip)', chooseMode(kmEdge, { rain: true }, world), 'cab');
eq('rain → cab even for a walkable trip', chooseMode(kmNear, { rain: true }, world), 'cab');
eq('no defaultMode → cab', chooseMode(5, null, { travel: { walkMaxKm: 1 } }), 'cab');

section('travel minutes');
const kmAB = 0.1 * KM_PER_DEG;
const offPeak = planTrip('place:a', 'place:b', utc(TUE, 7), null, world);
eq('off-peak scooter trip', offPeak, {
  from: 'place:a', to: 'place:b', mode: 'scooter', km: Math.round(kmAB * 1000) / 1000,
  minutes: expectMin(kmAB, 'scooter', 1), cost: Math.round(kmAB * 1.35 * 2 * 100) / 100,
});
eq('off-peak minutes = 5 + 11.12×1.35/22×60', offPeak.minutes, 46);
const peak = travelMinutes('place:a', 'place:b', utc(TUE, 8, 45), null, world);
eq('peak (×1.6) minutes', peak, expectMin(kmAB, 'scooter', 1.6));
check('peak trip is longer than off-peak', peak > offPeak.minutes, { peak, off: offPeak.minutes });
const movingOff = ((kmAB * 1.35) / 22) * 60;
eq('overhead is not scaled by the peak factor', peak, Math.round(5 + movingOff * 1.6));
check('…which differs from scaling the whole trip', peak !== Math.round((5 + movingOff) * 1.6), { peak });
eq('weekend uses weekendFactor', travelMinutes('place:a', 'place:b', utc(SUN, 8, 45), null, world), expectMin(kmAB, 'scooter', 1.2));
const rainy = planTrip('place:a', 'place:b', utc(TUE, 7), { rain: true, tempC: 22 }, world);
eq('rain trip goes by cab', rainy.mode, 'cab');
eq('rain trip minutes use cab speed + overhead', rainy.minutes, expectMin(kmAB, 'cab', 1));
eq('cab cost from costPerKm', rainy.cost, travelCost(kmAB, 'cab', world));
near('travelCost = km × roadFactor × perKm', travelCost(10, 'cab', world), 10 * 1.35 * 15, 0.01);
const walk = planTrip('place:a', 'place:near', utc(TUE, 7), null, world);
eq('short dry trip walks', walk.mode, 'walk');
eq('walk minutes', walk.minutes, expectMin(kmNear, 'walk', 1));
eq('walk is free', walk.cost, 0);
// Walking ignores traffic (PEAK_EXEMPT): the same at peak as off-peak.
const peakHour = utc(TUE, 9, 15);
check('09:15 is peak for the walk check', peakFactor(peakHour, world) > 1);
eq('a walk takes as long at peak as off-peak', planTrip('place:a', 'place:near', peakHour, null, world).minutes, walk.minutes);
check('a forced cab at the same time is slower', planTrip('place:a', 'place:b', peakHour, null, world, { mode: 'cab' }).minutes
  > planTrip('place:a', 'place:b', utc(TUE, 7), null, world, { mode: 'cab' }).minutes);
eq('forced mode', planTrip('place:a', 'place:b', utc(TUE, 7), null, world, { mode: 'cab' }).mode, 'cab');
eq('same place → zero trip', planTrip('place:b', 'place:b', utc(TUE, 9), null, world),
  { from: 'place:b', to: 'place:b', mode: 'walk', km: 0, minutes: 0, cost: 0 });
eq('raw coordinates accepted (ids null)', planTrip({ lat: 0, lon: 0 }, { lat: 0.1, lon: 0 }, utc(TUE, 7), null, world).minutes, offPeak.minutes);
eq('places as a Map', travelMinutes('place:a', 'place:b', utc(TUE, 7), null,
  { ...world, places: new Map(world.places.map(p => [p.id, p])) }), offPeak.minutes);
eq('tiny real distance is at least 1 minute', travelMinutes({ lat: 0, lon: 0 }, { lat: 0.00002, lon: 0 }, utc(TUE, 7), null, world), 1);
throws('unknown place throws', () => travelMinutes('place:a', 'place:nowhere', utc(TUE, 7), null, world), /unknown place/);
throws('mode without a speed throws', () => planTrip('place:a', 'place:b', utc(TUE, 7), null, world, { mode: 'boat' }), /no speed/);

section('position');
eq('lerp halfway', lerpPosition({ lat: 0, lon: 0 }, { lat: 1, lon: 2 }, 0.5), { lat: 0.5, lon: 1 });
eq('lerp clamps', lerpPosition({ lat: 0, lon: 0 }, { lat: 1, lon: 2 }, 3), { lat: 1, lon: 2 });

section('committed example world');
const example = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'src/personality/world.example.json'), 'utf-8'));
const commute = planTrip(example.self.homePlaceId, example.self.job.officePlaceId, utc(TUE, 3, 30), null, example);
check('home → office commute is plausible (5–120 min)', commute.minutes >= 5 && commute.minutes <= 120, commute);
check('example travel block has walk, cab and its default mode',
  ['walk', 'cab', example.travel.defaultMode].every(m => example.travel.speedsKmh[m] > 0));

report();
