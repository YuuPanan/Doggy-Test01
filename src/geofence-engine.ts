import { z } from 'zod';

export type Point = { lat: number; lon: number };
type Coordinate = [number, number];
const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees: number) => degrees * Math.PI / 180;
const same = (a: Coordinate, b: Coordinate) => a[0] === b[0] && a[1] === b[1];
const vertices = (coordinates: Coordinate[]) => same(coordinates[0], coordinates.at(-1)!) ? coordinates.slice(0, -1) : coordinates;
const cross = (a: Coordinate, b: Coordinate, c: Coordinate) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

function onSegment(a: Coordinate, b: Coordinate, p: Coordinate) {
  return Math.abs(cross(a, b, p)) < 1e-12 && p[0] >= Math.min(a[0], b[0]) - 1e-12 && p[0] <= Math.max(a[0], b[0]) + 1e-12
    && p[1] >= Math.min(a[1], b[1]) - 1e-12 && p[1] <= Math.max(a[1], b[1]) + 1e-12;
}

function intersects(a: Coordinate, b: Coordinate, c: Coordinate, d: Coordinate) {
  return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

export const geometrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('circle'), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180),
    radius_m: z.number().positive().max(100_000),
  }),
  z.object({
    type: z.literal('polygon'),
    coordinates: z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(3).max(101),
  }).superRefine((polygon, ctx) => {
    const points = vertices(polygon.coordinates);
    const area = points.reduce((total, a, i) => {
      const b = points[(i + 1) % points.length];
      return total + a[0] * b[1] - b[0] * a[1];
    }, 0);
    if (points.length < 3 || Math.abs(area) < 1e-12 || points.some((a, i) => same(a, points[(i + 1) % points.length]))) {
      ctx.addIssue({ code: 'custom', message: '多边形必须有至少三个不共线、互不相邻重复的顶点' });
      return;
    }
    // shortcut: local polygon edges use a planar projection; use PostGIS for dateline, polar or large-area fences.
    if (Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0])) >= 180) {
      ctx.addIssue({ code: 'custom', message: '本地 MVP 不支持跨 180 度经线的多边形' });
    }
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (intersects(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length])) {
        ctx.addIssue({ code: 'custom', message: '多边形不能自相交或重复触及边界' });
        return;
      }
    }
  }),
]);
export type Geometry = z.infer<typeof geometrySchema>;
export type FenceSide = 'inside' | 'outside' | 'uncertain';
export type FenceState = { status: 'unknown' | 'inside' | 'outside'; candidate: 'inside' | 'outside' | null; count: number };

export function distanceMeters(a: Point, b: Point) {
  const sinLat = Math.sin(radians(b.lat - a.lat) / 2);
  const sinLon = Math.sin(radians(b.lon - a.lon) / 2);
  const h = sinLat * sinLat + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

function segmentDistance(a: Coordinate, b: Coordinate, point: Point) {
  const project = (p: Coordinate): Coordinate => [radians(p[0] - point.lon) * EARTH_RADIUS_M * Math.cos(radians(point.lat)), radians(p[1] - point.lat) * EARTH_RADIUS_M];
  const [ax, ay] = project(a);
  const [bx, by] = project(b);
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function evaluateFence(geometry: Geometry, point: Point, bufferM = 0): FenceSide {
  if (geometry.type === 'circle') {
    const signedDistance = distanceMeters(geometry, point) - geometry.radius_m;
    if (bufferM > 0 && Math.abs(signedDistance) <= bufferM) return 'uncertain';
    return signedDistance <= 1e-7 ? 'inside' : 'outside';
  }
  const points = vertices(geometry.coordinates);
  const coordinate: Coordinate = [point.lon, point.lat];
  let inside = false;
  let boundary = false;
  let edgeDistance = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    boundary ||= onSegment(a, b, coordinate);
    edgeDistance = Math.min(edgeDistance, segmentDistance(a, b, point));
    if ((a[1] > point.lat) !== (b[1] > point.lat) && point.lon < (b[0] - a[0]) * (point.lat - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  if (bufferM > 0 && edgeDistance <= bufferM) return 'uncertain';
  return boundary || inside ? 'inside' : 'outside';
}

export function advanceFence(previous: FenceState, side: FenceSide, requiredPoints = 2): { state: FenceState; transition: 'exited' | 'entered' | null } {
  if (side === 'uncertain') return { state: { ...previous, candidate: null, count: 0 }, transition: null };
  if (side === previous.status || (previous.status === 'unknown' && side === 'inside')) {
    return { state: { status: side, candidate: null, count: 0 }, transition: null };
  }
  const count = previous.candidate === side ? previous.count + 1 : 1;
  if (count < requiredPoints) return { state: { ...previous, candidate: side, count }, transition: null };
  return { state: { status: side, candidate: null, count: 0 }, transition: side === 'outside' ? 'exited' : 'entered' };
}
