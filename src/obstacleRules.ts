/**
 * How each OSM obstacle class modifies the simulation bed. Tweak freely: the
 * PMTiles archive only stores `kind`/`class`/`width`, physics lives here.
 *
 * blocked: no-flow cell (wall/building). dz: bed raise (+) or lowering (-) in m.
 * n: Manning roughness (s/m^(1/3)); omitted = keep background roughness.
 * width: default footprint width in m for line features (OSM `width` overrides).
 */
export interface Rule { blocked?: boolean; dz?: number; n?: number; width: number }

/** `bridge` and `water` don't paint rules; they feed the bed override in channels.ts. */
export type Kind = 'building' | 'road' | 'barrier' | 'embankment' | 'waterway' | 'bridge' | 'water';

const ROAD_DEFAULT: Rule = { dz: 0.15, n: 0.02, width: 6 };
const ROADS: Record<string, Rule> = {
  motorway: { dz: 0.5, n: 0.016, width: 22 },
  trunk: { dz: 0.4, n: 0.016, width: 16 },
  primary: { dz: 0.25, n: 0.016, width: 12 },
  secondary: { dz: 0.2, n: 0.016, width: 10 },
  tertiary: { dz: 0.2, n: 0.016, width: 8 },
  residential: { dz: 0.15, n: 0.016, width: 7 },
  service: { dz: 0.1, n: 0.018, width: 4 },
  track: { dz: 0.1, n: 0.03, width: 3 },
  footway: { dz: 0.05, n: 0.025, width: 2 },
  path: { dz: 0.05, n: 0.03, width: 1.5 },
  cycleway: { dz: 0.05, n: 0.02, width: 2 },
  rail: { dz: 0.6, n: 0.06, width: 5 },
};

const BARRIERS: Record<string, Rule> = {
  wall: { blocked: true, width: 0.5 },
  city_wall: { blocked: true, width: 2 },
  flood_wall: { blocked: true, width: 0.5 },
  retaining_wall: { blocked: true, width: 0.5 },
  jersey_barrier: { dz: 0.8, width: 0.6 },
  kerb: { dz: 0.15, width: 0.3 },
  fence: { n: 0.08, width: 0.5 },
  guard_rail: { n: 0.05, width: 0.5 },
  hedge: { dz: 0.2, n: 0.12, width: 1.5 },
};

const WATERWAYS: Record<string, Rule> = {
  river: { dz: -2.0, n: 0.03, width: 15 },
  canal: { dz: -2.0, n: 0.025, width: 10 },
  stream: { dz: -0.8, n: 0.035, width: 3 },
  brook: { dz: -0.6, n: 0.035, width: 2 },
  tidal_channel: { dz: -1.0, n: 0.03, width: 5 },
  drain: { dz: -0.6, n: 0.025, width: 2 },
  ditch: { dz: -0.6, n: 0.035, width: 2 },
  culvert: { dz: -0.6, n: 0.02, width: 1.5 },
};

export function ruleFor(kind: Kind, cls: string): Rule | null {
  switch (kind) {
    case 'building': return { blocked: true, width: 0 };
    case 'road': return ROADS[cls] ?? (cls.endsWith('_link') ? ROADS[cls.slice(0, -5)] ?? ROAD_DEFAULT : ROAD_DEFAULT);
    case 'embankment': return { dz: 2.0, n: 0.05, width: 10 };
    case 'barrier': return BARRIERS[cls] ?? null;
    case 'waterway': return WATERWAYS[cls] ?? { dz: -0.5, n: 0.03, width: 2 };
    case 'bridge': case 'water': return null;
  }
}

/** Paint order: later kinds overwrite earlier ones where they overlap. */
export const PAINT_ORDER: Kind[] = ['road', 'embankment', 'barrier', 'waterway', 'building'];
