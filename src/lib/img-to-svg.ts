export interface SVGOptions {
    maxSize?: number;
    alphaCutoff?: number;
    inkL?: number;
    detail?: number;
    smoothness?: number;
}

type RequiredSVGOptions = Required<SVGOptions>;

interface ImageDataLike {
    data: Uint8ClampedArray | Uint8Array;
    width: number;
    height: number;
}

/** Internal tolerances, all derived from the options and the image (see `derive`). */
interface Params {
    minRegionArea: number;
    expand: number;
    flatTol: number;
    stopTol: number;
    maxStops: number;
    bins: number;
    curveTol: number;
    cornerAngle: number;
    cornerWindow: number;
    minRingArea: number;
    edgeT: number;
}

interface PathItem {
    d: string;
    fill: string;
}

interface RenderContext {
    p: Params;
    w: number;
    h: number;
    lab: Float32Array;
    ink: Uint8Array;
    soft: Float32Array;
    inkLabels: Int32Array;
    labels: Int32Array;
    fmt: (v: number) => string;
    fmtT: (v: number) => string;
    defs: string[];
    gradCount: number;
    rank: Int32Array;
}

export interface ColorProfile {
    err: number;
    tmin: number;
    tmax: number;
    span: number;
    cnt: Float64Array;
    S: Float64Array;
}

/** Describes one tunable option: its default, valid range and what it does. */
export interface OptionSpec {
    /** Short human-readable name, suitable for a UI label. */
    label: string;
    default: number;
    min: number;
    max: number;
    /** If true, values are rounded to whole numbers when resolved. */
    integer?: boolean;
    description: string;
}

/**
 * All options with default, min, max and description.
 * Useful for building settings UIs (sliders, tooltips) as well as for resolving options.
 */
export const OPTIONS: { [K in keyof SVGOptions]-?: OptionSpec } = {
    maxSize: {
        label: "Max size",
        default: 1600,
        min: 64,
        max: 8192,
        integer: true,
        description:
            "Longest side, in pixels, of the working image. Larger inputs are box-downscaled to this size before analysis; the SVG viewBox follows the working size while width/height keep the original size. Higher = more detail but slower.",
    },
    alphaCutoff: {
        label: "Alpha cutoff",
        default: 128,
        min: 1,
        max: 255,
        integer: true,
        description:
            "Pixels with alpha below this value are treated as transparent and left empty in the SVG. Raise it to cut off semi-transparent fringes, lower it to keep faint edges.",
    },
    inkL: {
        label: "Ink lightness",
        default: 0.2,
        min: 0,
        max: 0.6,
        description:
            "OKLab lightness below which a pixel counts as solid 'ink' (outlines, black spots). Ink is traced as its own top layer. Raise it to treat more dark colors as ink; set 0 to disable.",
    },
    detail: {
        label: "Detail",
        default: 0.5,
        min: 0,
        max: 1,
        description:
            "How faithfully colors and shapes are followed. Low = fewer regions, flatter fills, fewer gradient stops (small files). High = more regions and subtle shading (larger files). Edge sensitivity and color tolerances are all derived from this.",
    },
    smoothness: {
        label: "Smoothness",
        default: 0.5,
        min: 0,
        max: 1,
        description:
            "How much outlines are simplified. Low = paths hug the pixels tightly (more curves). High = rounder, simpler paths with far fewer curves.",
    },
};

/**
 * Merge user options over the defaults. Values are clamped to [min, max] (and rounded
 * for integer options); missing or invalid values fall back to the default.
 */
export function resolveOptions(opts?: SVGOptions): RequiredSVGOptions {
    const out: Record<string, number> = {};
    for (const key of Object.keys(OPTIONS) as (keyof SVGOptions)[]) {
        const spec = OPTIONS[key];
        let v = opts?.[key];
        if (typeof v !== "number" || !Number.isFinite(v)) v = spec.default;
        v = Math.min(spec.max, Math.max(spec.min, v));
        out[key] = spec.integer ? Math.round(v) : v;
    }
    return out as unknown as RequiredSVGOptions;
}

/**
 * Turn the two sliders into concrete tolerances. Pixel-based values scale with the
 * working image size, so the same settings behave alike on a 300px icon and a 3000px scan.
 * `edgeT` is a base value; the main function raises it for noisy images.
 */
function derive(o: RequiredSVGOptions, w: number, h: number): Params {
    const s = Math.min(3, Math.max(0.6, Math.max(w, h) / 1000));
    const k = 2 ** (1 - 2 * o.detail);
    const sm = 2 ** (2 * o.smoothness - 1);
    return {
        minRegionArea: Math.max(4, Math.round(7.5 * s * s)),
        expand: Math.min(4, Math.max(1, Math.round(1.6 * s))),
        flatTol: 0.012 * k,
        stopTol: 0.008 * k,
        maxStops: 6,
        bins: 32,
        curveTol: 0.64 * Math.max(1.25, s) * sm,
        cornerAngle: 50,
        cornerWindow: Math.min(12, Math.max(2, Math.round(3.2 * s))),
        minRingArea: 2.4 * s * s,
        edgeT: 0.02 * Math.sqrt(k),
    };
}

/* ------------------------------------------------------------------ color */

const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
    const c = i / 255;
    S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const s2l = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const l2s = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function linToOklab(r: number, g: number, b: number, out: Float32Array, off: number): void {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    out[off] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    out[off + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    out[off + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

function oklabToRgb01(L: number, a: number, b: number): [number, number, number] {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [
        clamp01(l2s(clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s))),
        clamp01(l2s(clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s))),
        clamp01(l2s(clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))),
    ];
}

function rgb01ToOklab(r: number, g: number, b: number): number[] {
    const out = new Float32Array(3);
    linToOklab(s2l(r), s2l(g), s2l(b), out, 0);
    return [out[0], out[1], out[2]];
}

const hex = (c: number[]): string =>
    "#" +
    c
        .map((v) =>
            Math.round(v * 255)
                .toString(16)
                .padStart(2, "0")
        )
        .join("");

/* ----------------------------------------------------------- image helpers */

function boxDownscale(src: ImageDataLike, f: number): ImageDataLike {
    const w = Math.max(1, Math.round(src.width / f));
    const h = Math.max(1, Math.round(src.height / f));
    const data = new Uint8ClampedArray(w * h * 4);
    const sx = src.width / w,
        sy = src.height / h;
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * sy),
            y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sy));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * sx),
                x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sx));
            let r = 0,
                g = 0,
                b = 0,
                a = 0,
                c = 0;
            for (let yy = y0; yy < y1 && yy < src.height; yy++) {
                for (let xx = x0; xx < x1 && xx < src.width; xx++) {
                    const i = (yy * src.width + xx) * 4;
                    r += src.data[i];
                    g += src.data[i + 1];
                    b += src.data[i + 2];
                    a += src.data[i + 3];
                    c++;
                }
            }
            const o = (y * w + x) * 4;
            data[o] = r / c;
            data[o + 1] = g / c;
            data[o + 2] = b / c;
            data[o + 3] = a / c;
        }
    }
    return { width: w, height: h, data };
}

function labelComponents(mask: Uint8Array, w: number, h: number, eight: boolean) {
    const n = w * h;
    const labels = new Int32Array(n).fill(-1);
    const sizes: number[] = [];
    const stack = new Int32Array(n);
    let count = 0;
    for (let s = 0; s < n; s++) {
        if (!mask[s] || labels[s] !== -1) continue;
        let sp = 0,
            size = 0;
        stack[sp++] = s;
        labels[s] = count;
        while (sp) {
            const p = stack[--sp];
            size++;
            const x = p % w,
                y = (p / w) | 0;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    if (!eight && dx && dy) continue;
                    const xx = x + dx;
                    if (xx < 0 || xx >= w) continue;
                    const q = yy * w + xx;
                    if (mask[q] && labels[q] === -1) {
                        labels[q] = count;
                        stack[sp++] = q;
                    }
                }
            }
        }
        sizes.push(size);
        count++;
    }
    return { labels, sizes, count };
}

function groupPixels(labels: Int32Array, count: number): Int32Array[] {
    const sizes = new Int32Array(count);
    for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) sizes[labels[i]]++;
    const lists = Array.from({ length: count }, (_, k) => new Int32Array(sizes[k]));
    const fill = new Int32Array(count);
    for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        if (l >= 0) lists[l][fill[l]++] = i;
    }
    return lists;
}

/* ---------------------------------------------------------------- vectors */

const sub = (a: number[], b: number[]): [number, number] => [a[0] - b[0], a[1] - b[1]];
const add = (a: number[], b: number[]): [number, number] => [a[0] + b[0], a[1] + b[1]];
const mul = (a: number[], s: number): [number, number] => [a[0] * s, a[1] * s];
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1];
const len = (a: number[]): number => Math.hypot(a[0], a[1]);
const unit = (a: number[]): [number, number] => {
    const l = len(a);
    return l ? [a[0] / l, a[1] / l] : [0, 0];
};
const sqd = (a: number[], b: number[]): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/* ---------------------------------------------- Bézier fitting (Schneider) */

function bezAt(b: number[][], t: number): [number, number] {
    const s = 1 - t;
    const a0 = s * s * s,
        a1 = 3 * s * s * t,
        a2 = 3 * s * t * t,
        a3 = t * t * t;
    return [
        a0 * b[0][0] + a1 * b[1][0] + a2 * b[2][0] + a3 * b[3][0],
        a0 * b[0][1] + a1 * b[1][1] + a2 * b[2][1] + a3 * b[3][1],
    ];
}
function bezD1(b: number[][], t: number): [number, number] {
    const s = 1 - t;
    const q0 = 3 * s * s,
        q1 = 6 * s * t,
        q2 = 3 * t * t;
    return [
        q0 * (b[1][0] - b[0][0]) + q1 * (b[2][0] - b[1][0]) + q2 * (b[3][0] - b[2][0]),
        q0 * (b[1][1] - b[0][1]) + q1 * (b[2][1] - b[1][1]) + q2 * (b[3][1] - b[2][1]),
    ];
}
function bezD2(b: number[][], t: number): [number, number] {
    const s = 1 - t;
    return [
        6 * (s * (b[2][0] - 2 * b[1][0] + b[0][0]) + t * (b[3][0] - 2 * b[2][0] + b[1][0])),
        6 * (s * (b[2][1] - 2 * b[1][1] + b[0][1]) + t * (b[3][1] - 2 * b[2][1] + b[1][1])),
    ];
}

function chordParams(pts: number[][]): number[] {
    const u = [0];
    for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + Math.sqrt(sqd(pts[i], pts[i - 1])));
    const total = u[u.length - 1] || 1;
    for (let i = 1; i < u.length; i++) u[i] /= total;
    return u;
}

function generateBezier(pts: number[][], u: number[], t1: number[], t2: number[]): number[][] {
    const n = pts.length,
        p0 = pts[0],
        p3 = pts[n - 1];
    let c00 = 0,
        c01 = 0,
        c11 = 0,
        x0 = 0,
        x1 = 0;
    for (let i = 0; i < n; i++) {
        const t = u[i],
            s = 1 - t;
        const b0 = s * s * s,
            b1 = 3 * s * s * t,
            b2 = 3 * s * t * t,
            b3 = t * t * t;
        const a1 = mul(t1, b1),
            a2 = mul(t2, b2);
        c00 += dot(a1, a1);
        c01 += dot(a1, a2);
        c11 += dot(a2, a2);
        const tmp = sub(pts[i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
        x0 += dot(a1, tmp);
        x1 += dot(a2, tmp);
    }
    const det = c00 * c11 - c01 * c01;
    let al = 0,
        ar = 0;
    if (Math.abs(det) > 1e-12) {
        al = (x0 * c11 - x1 * c01) / det;
        ar = (c00 * x1 - c01 * x0) / det;
    }
    const seg = Math.sqrt(sqd(p0, p3));
    if (al < 1e-6 * seg || ar < 1e-6 * seg) {
        al = ar = seg / 3;
    }
    return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
}

function reparam(b: number[][], pts: number[][], u: number[]): number[] {
    return u.map((t, i) => {
        const d = sub(bezAt(b, t), pts[i]);
        const d1 = bezD1(b, t),
            d2 = bezD2(b, t);
        const num = dot(d, d1),
            den = dot(d1, d1) + dot(d, d2);
        return den === 0 ? t : Math.min(1, Math.max(0, t - num / den));
    });
}

function maxError(pts: number[][], b: number[][], u: number[]): [number, number] {
    let md = 0,
        sp = Math.floor(pts.length / 2);
    for (let i = 1; i < pts.length - 1; i++) {
        const d = sqd(bezAt(b, u[i]), pts[i]);
        if (d > md) {
            md = d;
            sp = i;
        }
    }
    return [md, sp];
}

function fitCubic(pts: number[][], t1: number[], t2: number[], tolSq: number, out: number[][][]): void {
    const n = pts.length;
    if (n === 2) {
        const d = Math.sqrt(sqd(pts[0], pts[1])) / 3;
        out.push([pts[0], add(pts[0], mul(t1, d)), add(pts[1], mul(t2, d)), pts[1]]);
        return;
    }
    let u = chordParams(pts);
    let b = generateBezier(pts, u, t1, t2);
    let [err, sp] = maxError(pts, b, u);
    if (err < tolSq) {
        out.push(b);
        return;
    }
    if (err < tolSq * 4) {
        for (let i = 0; i < 6; i++) {
            u = reparam(b, pts, u);
            b = generateBezier(pts, u, t1, t2);
            [err, sp] = maxError(pts, b, u);
            if (err < tolSq) {
                out.push(b);
                return;
            }
        }
    }
    const center = unit(sub(pts[sp - 1], pts[sp + 1]));
    fitCubic(pts.slice(0, sp + 1), t1, center, tolSq, out);
    fitCubic(pts.slice(sp), mul(center, -1), t2, tolSq, out);
}

/* ------------------------------------------------ segment fitting (lines + cubics) */

/** One piece of an outline: a straight line (`line`) or a cubic Bézier. `p` always holds 4 points. */
interface Seg {
    line: boolean;
    p: number[][];
    pts: number[][];
    smooth: boolean;
}

const rot = (v: number[], a: number): [number, number] => {
    const c = Math.cos(a),
        s = Math.sin(a);
    return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
};
const cross = (a: number[], b: number[]): number => a[0] * b[1] - a[1] * b[0];

/** Largest distance of any point to the infinite line through the first and last point. */
function lineDevSq(pts: number[][]): number {
    const a = pts[0],
        b = pts[pts.length - 1];
    const d = sub(b, a);
    const l = len(d);
    if (!l) return Infinity;
    let m = 0;
    for (let i = 1; i < pts.length - 1; i++) {
        const c = cross(d, sub(pts[i], a)) / l;
        if (c * c > m) m = c * c;
    }
    return m;
}

/** Squared distance from a point to the segment (a, b). */
function segDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax,
        dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * dx - px,
        qy = ay + t * dy - py;
    return qx * qx + qy * qy;
}

/**
 * Largest squared distance from the (ordered) points to the curve. Uses true point-to-curve
 * distance, not parametric error, so a curve is judged by how close it really runs to the outline.
 */
function maxDistSq(b: number[][], pts: number[][], stride: number): number {
    const ctrl = len(sub(b[1], b[0])) + len(sub(b[2], b[1])) + len(sub(b[3], b[2]));
    const M = Math.min(300, Math.max(16, Math.ceil(ctrl / 2)));
    const S = new Float64Array(2 * (M + 1));
    for (let i = 0; i <= M; i++) {
        const q = bezAt(b, i / M);
        S[2 * i] = q[0];
        S[2 * i + 1] = q[1];
    }
    const n = pts.length;
    let worst = 0,
        j0 = 0,
        first = true;
    for (let k = 0; k < n; k += k + stride >= n && k !== n - 1 ? n - 1 - k : stride) {
        const p = pts[k];
        let jm = 0,
            dm = Infinity;
        const from = first ? 0 : Math.max(0, j0 - 2);
        for (let j = from; j < M; j++) {
            const d = segDistSq(p[0], p[1], S[2 * j], S[2 * j + 1], S[2 * j + 2], S[2 * j + 3]);
            if (d < dm) {
                dm = d;
                jm = j;
            } else if (!first && j - jm > 8) break;
        }
        first = false;
        j0 = jm;
        if (dm > worst) worst = dm;
        if (k === n - 1) break;
    }
    return worst;
}

/** Plain Nelder-Mead minimiser (few dimensions, few iterations). */
function nmN(fn: (x: number[]) => number, x0: number[], steps: number[], iters: number): { x: number[]; v: number } {
    const dim = x0.length;
    let S = [x0, ...x0.map((_, i) => x0.map((v, k) => (k === i ? v + steps[i] : v)))].map((p) => ({ p, v: fn(p) }));
    for (let it = 0; it < iters; it++) {
        S.sort((a, b) => a.v - b.v);
        const c = new Array(dim).fill(0);
        for (let i = 0; i < dim; i++) for (let k = 0; k < dim; k++) c[k] += S[i].p[k] / dim;
        const w = S[dim];
        const xr = c.map((v, k) => 2 * v - w.p[k]);
        const fr = fn(xr);
        if (fr < S[0].v) {
            const xe = c.map((v, k) => 3 * v - 2 * w.p[k]);
            const fe = fn(xe);
            S[dim] = fe < fr ? { p: xe, v: fe } : { p: xr, v: fr };
        } else if (fr < S[dim - 1].v) S[dim] = { p: xr, v: fr };
        else {
            const xc = c.map((v, k) => (v + w.p[k]) / 2);
            const fc = fn(xc);
            if (fc < w.v) S[dim] = { p: xc, v: fc };
            else {
                const b0 = S[0].p;
                S = S.map((s, i) => {
                    if (!i) return s;
                    const p = s.p.map((v, k) => (v + b0[k]) / 2);
                    return { p, v: fn(p) };
                });
            }
        }
    }
    S.sort((a, b) => a.v - b.v);
    return { x: S[0].p, v: S[0].v };
}

/**
 * Cubic through `pts` that stays as close as possible to all of them. Starts from the least-squares
 * (Schneider) solution, then, if that is not already clearly good, tunes the two handle lengths and
 * (for free ends) the two end tangents to minimise the worst-case distance.
 * Returns null when it is hopeless (so callers can reject long runs cheaply).
 */
function fitCubicFit(
    pts: number[][],
    t1: number[],
    t2: number[],
    free1: boolean,
    free2: boolean,
    tolSq: number,
    lim2 = 0.35
): { b: number[][]; err: number } | null {
    const n = pts.length;
    const p0 = pts[0],
        p3 = pts[n - 1];
    const L = Math.max(1e-6, Math.sqrt(sqd(p0, p3)));
    let u = chordParams(pts);
    let b = generateBezier(pts, u, t1, t2);
    for (let r = 0; r < 2; r++) {
        u = reparam(b, pts, u);
        b = generateBezier(pts, u, t1, t2);
    }
    const stride = Math.max(1, Math.floor(n / 90));
    const e = maxDistSq(b, pts, 1);
    if (e < tolSq * 0.15) return { b, err: e };
    if (e > tolSq * 36) return null;

    const a1 = len(sub(b[1], p0)),
        a2 = len(sub(b[2], p3));
    const LIM = 0.35;
    const build = (x: number[]): number[][] => {
        const ta = free1 ? rot(t1, x[2]) : t1;
        const tb = free2 ? rot(t2, x[free1 ? 3 : 2]) : t2;
        return [p0, add(p0, mul(ta, x[0])), add(p3, mul(tb, x[1])), p3];
    };
    const cost = (x: number[]): number => {
        if (x[0] < 0.02 * L || x[1] < 0.02 * L || x[0] > 1.5 * L || x[1] > 1.5 * L) return 1e12;
        let q = 2;
        if (free1) {
            if (Math.abs(x[q++]) > LIM) return 1e12;
        }
        if (free2 && Math.abs(x[q]) > lim2) return 1e12;
        return maxDistSq(build(x), pts, stride);
    };
    const x0 = [a1, a2];
    const st = [0.08 * L, 0.08 * L];
    if (free1) {
        x0.push(0);
        st.push(0.04);
    }
    if (free2) {
        x0.push(0);
        st.push(0.04);
    }
    const r = nmN(cost, x0, st, 80 + 30 * x0.length);
    const nb = build(r.x);
    const ne = maxDistSq(nb, pts, 1);
    return ne < e ? { b: nb, err: ne } : { b, err: e };
}

/**
 * Cover an open run of points with as few cubics as possible (the longest ones that stay inside
 * the tolerance). Pieces too short to curve (fewer than 3 points) become lines.
 *   t1 / t2: tangent at the start (pointing forward) and end (pointing backward), `fixed` = exact.
 */
function fitCurvesGreedy(
    pts: number[][],
    t1: number[],
    t1Fixed: boolean,
    t2: number[],
    t2Fixed: boolean,
    tolSq: number,
    K: number
): Seg[] {
    const last = pts.length - 1;
    const out: Seg[] = [];
    let i = 0;
    let fwd = t1;
    let fwdFixed = t1Fixed;

    const tangentAt = (j: number): number[] => {
        const w = Math.max(K, 12);
        const a = Math.max(0, j - w),
            b = Math.min(last, j + w);
        return unit(sub(pts[a], pts[b]));
    };

    const tryJ = (a: number, j: number): Seg | null => {
        const sl = pts.slice(a, j + 1);
        const endFixed = j === last && t2Fixed;
        if (sl.length < 3) {
            const p0 = sl[0],
                p3 = sl[sl.length - 1];
            return { line: true, p: [p0, p0, p3, p3], pts: sl, smooth: j < last || endFixed };
        }
        const endT = j === last ? t2 : tangentAt(j);
        const f = fitCubicFit(sl, fwd, endT, !fwdFixed, !endFixed, tolSq, j === last ? 0.35 : 0.08);
        if (!f || f.err >= tolSq) return null;
        return { line: false, p: f.b, pts: sl, smooth: j < last || endFixed };
    };

    while (i < last) {
        let ok = Math.min(last, i + 1);
        let best = tryJ(i, ok);
        if (!best) {
            const p0 = pts[i],
                p3 = pts[ok];
            best = { line: true, p: [p0, p0, p3, p3], pts: [p0, p3], smooth: ok < last };
        }
        let step = 8;
        let fail = -1;
        while (ok < last) {
            const j = Math.min(last, i + step);
            const r = tryJ(i, j);
            if (r) {
                best = r;
                ok = j;
                if (j === last) break;
                step *= 2;
            } else {
                fail = j;
                break;
            }
        }
        if (fail > 0) {
            let lo = ok,
                hi = fail;
            while (hi - lo > 3) {
                const mid = (lo + hi) >> 1;
                const r = tryJ(i, mid);
                if (r) {
                    best = r;
                    lo = mid;
                } else hi = mid;
            }
            ok = lo;
        }
        if (ok < last && last - ok <= 10) {
            const r = tryJ(i, last);
            if (r) {
                best = r;
                ok = last;
            }
        }
        out.push(best);
        i = ok;
        fwd = best.line ? unit(sub(best.p[3], best.p[0])) : unit(sub(best.p[3], best.p[2]));
        fwdFixed = true;
    }
    return out;
}

/**
 * Fit with the fewest cubics. The greedy pass finds how many are needed; then the points are dealt
 * out evenly between that many pieces, which fit far tighter than "one long piece + a short rest"
 * (and so show no kinks at the joins). Falls back to the greedy result if the even split does not fit.
 */
function fitCurves(
    pts: number[][],
    t1: number[],
    t1Fixed: boolean,
    t2: number[],
    t2Fixed: boolean,
    tolSq: number,
    K: number
): Seg[] {
    const greedy = fitCurvesGreedy(pts, t1, t1Fixed, t2, t2Fixed, tolSq, K);
    const n = greedy.length;
    if (n < 2 || greedy.some((g) => g.line)) return greedy;
    const last = pts.length - 1;
    const cum = new Float64Array(last + 1);
    for (let i = 1; i <= last; i++) cum[i] = cum[i - 1] + Math.sqrt(sqd(pts[i], pts[i - 1]));
    const w = Math.max(K, 12);
    const tanAt = (j: number): number[] => unit(sub(pts[Math.max(0, j - w)], pts[Math.min(last, j + w)]));
    const minChord = 6 * Math.sqrt(tolSq);
    const real = greedy.filter((g) => Math.hypot(g.p[3][0] - g.p[0][0], g.p[3][1] - g.p[0][1]) >= minChord).length;
    for (let m = Math.max(1, real); m <= real; m++) {
        const cut = [0];
        for (let q = 1; q < m; q++) {
            let j = cut[q - 1] + 1;
            const target = (cum[last] * q) / m;
            while (j < last && cum[j] < target) j++;
            cut.push(j);
        }
        cut.push(last);
        const out: Seg[] = [];
        let ok = true;
        for (let q = 0; q < m && ok; q++) {
            const a = cut[q],
                b = cut[q + 1];
            if (b - a < 3) {
                ok = false;
                break;
            }
            const sl = pts.slice(a, b + 1);
            const fwd = q === 0 ? t1 : mul(tanAt(a), -1);
            const bwd = q === m - 1 ? t2 : tanAt(b);
            const f = fitCubicFit(
                sl,
                fwd,
                bwd,
                q === 0 && !t1Fixed,
                q === m - 1 && !t2Fixed,
                tolSq,
                q === m - 1 ? 0.35 : 0.0
            );
            if (!f || f.err >= tolSq) ok = false;
            else out.push({ line: false, p: f.b, pts: sl, smooth: q < m - 1 || t2Fixed });
        }
        if (ok) return out;
    }
    return greedy;
}

/** Is the whole piece one straight line? Judged on its interior; the ends may be rounded by the trace. */
function isStraightPiece(pts: number[][], tolSq: number, stub: number): boolean {
    const last = pts.length - 1;
    if (last < 4 * stub) return lineDevSq(pts) < 0.36 * tolSq;
    const a = pts[stub],
        b = pts[last - stub];
    const dx = b[0] - a[0],
        dy = b[1] - a[1];
    const l = Math.hypot(dx, dy);
    if (!l) return false;
    for (let k = 0; k <= last; k++) {
        const c = (dx * (pts[k][1] - a[1]) - dy * (pts[k][0] - a[0])) / l;
        const lim = k < stub || k > last - stub ? 6.25 * tolSq : 0.36 * tolSq;
        if (c * c > lim) return false;
    }
    return true;
}

/**
 * Longest straight stretches of an open run: stretches that are both long and very straight
 * (far straighter than the curve tolerance), so gentle arcs are never chopped into polylines.
 */
function findLineRuns(pts: number[][], tolSq: number, minLen: number): [number, number][] {
    const last = pts.length - 1;
    const cum = new Float64Array(last + 1);
    for (let i = 1; i <= last; i++) cum[i] = cum[i - 1] + Math.sqrt(sqd(pts[i], pts[i - 1]));
    const devSq = Math.max(0.0225, 0.0625 * tolSq);
    const dev = (a: number, b: number): number => {
        const dx = pts[b][0] - pts[a][0],
            dy = pts[b][1] - pts[a][1];
        const l = Math.hypot(dx, dy);
        if (!l) return Infinity;
        let m = 0;
        for (let k = a + 1; k < b; k++) {
            const c = (dx * (pts[k][1] - pts[a][1]) - dy * (pts[k][0] - pts[a][0])) / l;
            if (c * c > m) m = c * c;
        }
        return m;
    };
    const out: [number, number][] = [];
    let i = 0;
    while (i < last) {
        let ok = i,
            step = 16,
            fail = -1;
        while (ok < last) {
            const j = Math.min(last, i + step);
            if (dev(i, j) <= devSq) {
                ok = j;
                if (j === last) break;
                step *= 2;
            } else {
                fail = j;
                break;
            }
        }
        if (fail > 0) {
            let lo = ok,
                hi = fail;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (dev(i, mid) <= devSq) lo = mid;
                else hi = mid;
            }
            ok = lo;
        }
        if (ok > i && cum[ok] - cum[i] >= minLen) {
            out.push([i, ok]);
            i = ok;
        } else i += 6;
    }
    return out;
}

/**
 * Fit an open run of points: exact straight lines where the outline is straight, and the fewest
 * smooth cubics in between (which leave and join each line along its direction).
 */
function fitRun(
    pts: number[][],
    t1: number[],
    t1Fixed: boolean,
    t2: number[],
    t2Fixed: boolean,
    tolSq: number,
    K: number
): Seg[] {
    const last = pts.length - 1;
    if (last >= 2 && !t1Fixed && !t2Fixed && isStraightPiece(pts, tolSq, Math.max(10, 3 * K))) {
        const p0 = pts[0],
            p3 = pts[last];
        return [{ line: true, p: [p0, p0, p3, p3], pts, smooth: false }];
    }
    const runs = findLineRuns(pts, tolSq, 80 * Math.sqrt(tolSq));
    const stub = Math.max(10, 3 * K);
    if (runs.length) {
        if (!t1Fixed && runs[0][0] <= stub) runs[0][0] = 0;
        const R = runs[runs.length - 1];
        if (!t2Fixed && last - R[1] <= stub) R[1] = last;
    }
    if (!runs.length) return fitCurves(pts, t1, t1Fixed, t2, t2Fixed, tolSq, K);
    const out: Seg[] = [];
    let pos = 0;
    let tin = t1,
        tinFixed = t1Fixed;
    for (let r = 0; r <= runs.length; r++) {
        const next = r < runs.length ? runs[r] : null;
        const gapEnd = next ? next[0] : last;
        if (gapEnd > pos) {
            const lineDir = next ? unit(sub(pts[next[1]], pts[next[0]])) : t2;
            const g = fitCurves(
                pts.slice(pos, gapEnd + 1),
                tin,
                tinFixed,
                next ? mul(lineDir, -1) : t2,
                next ? true : t2Fixed,
                tolSq,
                K
            );
            out.push(...g);
        }
        if (!next) break;
        const sl = pts.slice(next[0], next[1] + 1);
        const p0 = sl[0],
            p3 = sl[sl.length - 1];
        const end = next[1] === last;
        out.push({ line: true, p: [p0, p0, p3, p3], pts: sl, smooth: !end || t2Fixed });
        tin = unit(sub(p3, p0));
        tinFixed = true;
        pos = next[1];
    }
    return out;
}

/** Tidy the joins: axis-aligned lines become exact, corners between lines become exact intersections. */
function polishSegs(segs: Seg[], snap: number): void {
    for (let k = 0; k < segs.length && segs.length > 3;) {
        const s = segs[k];
        if (Math.hypot(s.p[3][0] - s.p[0][0], s.p[3][1] - s.p[0][1]) >= snap * 4) {
            k++;
            continue;
        }
        const pi = (k - 1 + segs.length) % segs.length;
        const prev = segs[pi];
        const dx = s.p[3][0] - prev.p[3][0],
            dy = s.p[3][1] - prev.p[3][1];
        prev.p[3] = s.p[3];
        prev.p[2] = prev.line ? prev.p[3] : [prev.p[2][0] + dx, prev.p[2][1] + dy];
        prev.smooth = s.smooth;
        segs.splice(k, 1);
        if (pi > k) k = Math.max(0, k - 1);
    }
    const n = segs.length;
    type L = { c: number[]; d: number[] };
    const lines: (L | null)[] = segs.map((s) => {
        if (!s.line) return null;
        const pts = s.pts;
        let cx = 0,
            cy = 0;
        for (const p of pts) {
            cx += p[0];
            cy += p[1];
        }
        cx /= pts.length;
        cy /= pts.length;
        let sxx = 0,
            sxy = 0,
            syy = 0;
        for (const p of pts) {
            const dx = p[0] - cx,
                dy = p[1] - cy;
            sxx += dx * dx;
            sxy += dx * dy;
            syy += dy * dy;
        }
        const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        let d: number[] = [Math.cos(th), Math.sin(th)];
        const fw = sub(s.p[3], s.p[0]);
        if (dot(d, fw) < 0) d = [-d[0], -d[1]];
        const L = len(fw);
        const tolA = Math.max(0.0105, Math.min(0.04, snap / Math.max(L, 1)));
        if (Math.abs(d[1]) < tolA) d = [Math.sign(d[0]) || 1, 0];
        else if (Math.abs(d[0]) < tolA) d = [0, Math.sign(d[1]) || 1];
        return { c: [cx, cy], d };
    });

    const project = (l: L, p: number[]): [number, number] => {
        const t = dot(sub(p, l.c), l.d);
        return [l.c[0] + l.d[0] * t, l.c[1] + l.d[1] * t];
    };
    const moveJoint = (k: number, P: number[]) => {
        const a = segs[k],
            b = segs[(k + 1) % n];
        const old = a.p[3];
        const dx = P[0] - old[0],
            dy = P[1] - old[1];
        a.p[3] = P;
        if (!a.line) a.p[2] = [a.p[2][0] + dx, a.p[2][1] + dy];
        else a.p[2] = P;
        b.p[0] = P;
        if (!b.line) b.p[1] = [b.p[1][0] + dx, b.p[1][1] + dy];
        else b.p[1] = P;
    };

    for (let k = 0; k < n; k++) {
        const la = lines[k],
            lb = lines[(k + 1) % n];
        const P = segs[k].p[3];
        if (la && lb) {
            const den = cross(la.d, lb.d);
            if (Math.abs(den) > 0.14) {
                const t = cross(sub(lb.c, la.c), lb.d) / den;
                const X: [number, number] = [la.c[0] + la.d[0] * t, la.c[1] + la.d[1] * t];
                if (Math.hypot(X[0] - P[0], X[1] - P[1]) < snap * 4) {
                    moveJoint(k, X);
                    continue;
                }
            }
            const Q = project(la, P);
            if (Math.hypot(Q[0] - P[0], Q[1] - P[1]) < snap * 2) moveJoint(k, Q);
        } else if (la || lb) {
            const l = (la || lb)!;
            const Q = project(l, P);
            if (Math.hypot(Q[0] - P[0], Q[1] - P[1]) < snap * 2) moveJoint(k, Q);
        }
    }

    for (let k = 0; k < n; k++) {
        const a = segs[k],
            b = segs[(k + 1) % n];
        if (!a.smooth) continue;
        const la = lines[k],
            lb = lines[(k + 1) % n];
        const P = a.p[3];
        if (la && lb) continue;
        let d: number[];
        if (la) d = la.d;
        else if (lb) d = lb.d;
        else {
            const da = unit(sub(P, a.p[2])),
                db = unit(sub(b.p[1], P));
            d = unit(add(da, db));
            if (!d[0] && !d[1]) continue;
        }
        if (!a.line) {
            const l = len(sub(P, a.p[2]));
            a.p[2] = [P[0] - d[0] * l, P[1] - d[1] * l];
        }
        if (!b.line) {
            const l = len(sub(b.p[1], P));
            b.p[1] = [P[0] + d[0] * l, P[1] + d[1] * l];
        }
    }
}

/**
 * Gaussian-smooth an open run of points, keeping both end points fixed (odd reflection at the ends,
 * so the end tangents survive). Removes pixel-level jitter so lines and arcs come out clean.
 */
function smoothRun(pts: number[][], sigma: number): number[][] {
    const n = pts.length;
    const r = Math.ceil(2.5 * sigma);
    if (n < 2 * r + 3) return pts;
    const wts: number[] = [];
    let ws = 0;
    for (let d = -r; d <= r; d++) {
        const w = Math.exp(-(d * d) / (2 * sigma * sigma));
        wts.push(w);
        ws += w;
    }
    const at = (i: number): number[] => {
        if (i < 0) return [2 * pts[0][0] - pts[-i][0], 2 * pts[0][1] - pts[-i][1]];
        if (i > n - 1) {
            const j = 2 * (n - 1) - i;
            return [2 * pts[n - 1][0] - pts[j][0], 2 * pts[n - 1][1] - pts[j][1]];
        }
        return pts[i];
    };
    const out: number[][] = [pts[0]];
    for (let i = 1; i < n - 1; i++) {
        let x = 0,
            y = 0;
        for (let d = -r; d <= r; d++) {
            const p = at(i + d);
            x += wts[d + r] * p[0];
            y += wts[d + r] * p[1];
        }
        out.push([x / ws, y / ws]);
    }
    out.push(pts[n - 1]);
    return out;
}

function ringToSegs(ring: number[][], o: Params): Seg[] | null {
    const n = ring.length;
    if (n < 4) return null;
    const k = Math.max(2, Math.min(o.cornerWindow, (n / 6) | 0));
    const thr = (o.cornerAngle * Math.PI) / 180;

    const ang = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const v1 = sub(ring[i], ring[(i - k + n) % n]);
        const v2 = sub(ring[(i + k) % n], ring[i]);
        const l1 = len(v1),
            l2 = len(v2);
        ang[i] = l1 && l2 ? Math.acos(Math.max(-1, Math.min(1, dot(v1, v2) / (l1 * l2)))) : 0;
    }
    let breaks: { i: number; corner: boolean }[] = [];
    for (let i = 0; i < n; i++) {
        if (ang[i] <= thr) continue;
        let isMax = true;
        for (let j = -k; j <= k && isMax; j++) {
            if (!j) continue;
            const a = ang[(i + j + n) % n];
            if (a > ang[i] || (a === ang[i] && j < 0)) isMax = false;
        }
        if (isMax) breaks.push({ i, corner: true });
    }
    if (breaks.length === 0)
        breaks = [
            { i: 0, corner: false },
            { i: n >> 1, corner: false },
        ];
    else if (breaks.length === 1) {
        breaks.push({ i: (breaks[0].i + (n >> 1)) % n, corner: false });
        breaks.sort((a, b) => a.i - b.i);
    }

    let bx0 = Infinity,
        by0 = Infinity,
        bx1 = -Infinity,
        by1 = -Infinity;
    for (const p of ring) {
        if (p[0] < bx0) bx0 = p[0];
        if (p[0] > bx1) bx1 = p[0];
        if (p[1] < by0) by0 = p[1];
        if (p[1] > by1) by1 = p[1];
    }
    const diag = Math.hypot(bx1 - bx0, by1 - by0);
    const tol = Math.min(o.curveTol, Math.max(0.2, 0.002 * diag));
    const tolSq = tol * tol;
    const all: Seg[] = [];
    for (let q = 0; q < breaks.length; q++) {
        const A = breaks[q],
            B = breaks[(q + 1) % breaks.length];
        const seg: number[][] = [];
        let i = A.i;
        do {
            seg.push(ring[i]);
            i = (i + 1) % n;
        } while (i !== B.i);
        seg.push(ring[B.i]);
        if (seg.length < 2) continue;
        const kt = Math.min(k + 1, seg.length - 1);
        const t1 = A.corner ? unit(sub(seg[kt], seg[0])) : unit(sub(ring[(A.i + k) % n], ring[(A.i - k + n) % n]));
        const t2 = B.corner
            ? unit(sub(seg[seg.length - 1 - kt], seg[seg.length - 1]))
            : unit(sub(ring[(B.i - k + n) % n], ring[(B.i + k) % n]));
        const sm = smoothRun(seg, Math.max(1.2, 0.6 * o.cornerWindow));
        all.push(...fitRun(sm, t1, !A.corner, t2, !B.corner, tolSq, Math.max(k, 4)));
    }
    if (!all.length) return null;
    polishSegs(all, tol);
    return all;
}

function makeFmt(p: number): (v: number) => string {
    return (v: number) => {
        const s = v.toFixed(p);
        if (s.indexOf(".") < 0) return s;
        const t = s.replace(/\.?0+$/, "");
        return t === "-0" || t === "" ? "0" : t;
    };
}

function segsToPath(segs: Seg[], fmt: (v: number) => string): string {
    let d = "M" + fmt(segs[0].p[0][0]) + " " + fmt(segs[0].p[0][1]);
    let cx = fmt(segs[0].p[0][0]),
        cy = fmt(segs[0].p[0][1]);
    for (const s of segs) {
        const ex = fmt(s.p[3][0]),
            ey = fmt(s.p[3][1]);
        if (s.line) {
            if (ex === cx && ey === cy) continue;
            if (ey === cy) d += "H" + ex;
            else if (ex === cx) d += "V" + ey;
            else d += "L" + ex + " " + ey;
        } else {
            d +=
                "C" +
                fmt(s.p[1][0]) +
                " " +
                fmt(s.p[1][1]) +
                " " +
                fmt(s.p[2][0]) +
                " " +
                fmt(s.p[2][1]) +
                " " +
                ex +
                " " +
                ey;
        }
        cx = ex;
        cy = ey;
    }
    return d + "Z";
}

/* -------------------------------------------------- marching squares + mask */

function ringArea(r: number[][]): number {
    let a = 0;
    for (let i = 0, n = r.length; i < n; i++) {
        const p = r[i],
            q = r[(i + 1) % n];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
}

const MS: (string[] | null)[] = [
    [],
    ["L", "T"],
    ["T", "R"],
    ["L", "R"],
    ["R", "B"],
    null,
    ["T", "B"],
    ["L", "B"],
    ["L", "B"],
    ["T", "B"],
    null,
    ["R", "B"],
    ["L", "R"],
    ["T", "R"],
    ["L", "T"],
    [],
];

function contourRings(f: Float32Array, W: number, H: number, ox: number, oy: number, iso: number): number[][][] {
    const adj = new Map<number, number[]>();
    const link = (a: number, b: number) => {
        let x = adj.get(a);
        if (!x) adj.set(a, (x = []));
        x.push(b);
        let y = adj.get(b);
        if (!y) adj.set(b, (y = []));
        y.push(a);
    };
    for (let y = 0; y < H - 1; y++) {
        for (let x = 0; x < W - 1; x++) {
            const a = f[y * W + x],
                b = f[y * W + x + 1];
            const c = f[(y + 1) * W + x + 1],
                d = f[(y + 1) * W + x];
            const idx = (a >= iso ? 1 : 0) | (b >= iso ? 2 : 0) | (c >= iso ? 4 : 0) | (d >= iso ? 8 : 0);
            if (idx === 0 || idx === 15) continue;
            const E: Record<string, number> = {
                T: 2 * (y * W + x),
                B: 2 * ((y + 1) * W + x),
                L: 2 * (y * W + x) + 1,
                R: 2 * (y * W + x + 1) + 1,
            };
            if (idx === 5 || idx === 10) {
                const center = (a + b + c + d) / 4 >= iso;
                if (idx === 5) {
                    if (center) {
                        link(E.T, E.R);
                        link(E.L, E.B);
                    } else {
                        link(E.L, E.T);
                        link(E.R, E.B);
                    }
                } else if (center) {
                    link(E.L, E.T);
                    link(E.R, E.B);
                } else {
                    link(E.T, E.R);
                    link(E.L, E.B);
                }
            } else {
                const e = MS[idx];
                if (e) link(E[e[0]], E[e[1]]);
            }
        }
    }

    const point = (id: number): [number, number] => {
        const vertical = id & 1,
            i = id >> 1;
        const x = i % W,
            y = (i / W) | 0;
        const v0 = f[i];
        if (!vertical) {
            const t = (iso - v0) / (f[i + 1] - v0);
            return [ox + x + t + 0.5, oy + y + 0.5];
        }
        const t = (iso - v0) / (f[i + W] - v0);
        return [ox + x + 0.5, oy + y + t + 0.5];
    };

    const rings: number[][][] = [];
    const seen = new Set<number>();
    for (const start of adj.keys()) {
        if (seen.has(start)) continue;
        const ring = [];
        let prev = -1,
            cur = start;
        while (true) {
            seen.add(cur);
            ring.push(point(cur));
            const nb = adj.get(cur);
            if (!nb || nb.length < 2) break;
            const next = nb[0] !== prev ? nb[0] : nb[1];
            prev = cur;
            if (next === start || seen.has(next)) break;
            cur = next;
        }
        rings.push(ring);
    }
    return rings;
}

function maskToPath(
    m: Uint8Array,
    W: number,
    H: number,
    bx: number,
    by: number,
    imgW: number,
    imgH: number,
    o: Params,
    fmt: (v: number) => string
): string {
    const f = new Float32Array(W * H);
    for (let ly = 1; ly < H - 1; ly++) {
        const gy = by + ly,
            cy = gy < 0 ? 0 : gy >= imgH ? imgH - 1 : gy;
        for (let lx = 1; lx < W - 1; lx++) {
            const gx = bx + lx,
                cx = gx < 0 ? 0 : gx >= imgW ? imgW - 1 : gx;
            f[ly * W + lx] = m[(cy - by) * W + (cx - bx)];
        }
    }
    const tmp = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const l = f[y * W + (x > 0 ? x - 1 : x)],
                r = f[y * W + (x < W - 1 ? x + 1 : x)];
            tmp[y * W + x] = (l + 2 * f[y * W + x] + r) / 4;
        }
    }
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const u = tmp[(y > 0 ? y - 1 : y) * W + x],
                d = tmp[(y < H - 1 ? y + 1 : y) * W + x];
            f[y * W + x] = (u + 2 * tmp[y * W + x] + d) / 4;
        }
    }
    return fieldToPath(f, W, H, bx, by, o, fmt);
}

function fieldToPath(
    f: Float32Array,
    W: number,
    H: number,
    bx: number,
    by: number,
    o: Params,
    fmt: (v: number) => string
): string {
    const rings = contourRings(f, W, H, bx, by, 0.5);
    let d = "";
    for (const ring of rings) {
        if (ring.length < 4 || ringArea(ring) < o.minRingArea) continue;
        const sg = ringToSegs(ring, o);
        if (sg && sg.length) d += segsToPath(sg, fmt);
    }
    return d;
}

/* -------------------------------------------------------- gradient fitting */

function binProfile(ts: Float64Array, cols: Float64Array, n: number, B: number, sumSq: number) {
    let tmin = Infinity,
        tmax = -Infinity;
    for (let i = 0; i < n; i++) {
        if (ts[i] < tmin) tmin = ts[i];
        if (ts[i] > tmax) tmax = ts[i];
    }
    const span = tmax - tmin || 1;
    const cnt = new Float64Array(B),
        S = new Float64Array(3 * B);
    for (let i = 0; i < n; i++) {
        let b = (((ts[i] - tmin) / span) * B) | 0;
        if (b >= B) b = B - 1;
        cnt[b]++;
        S[3 * b] += cols[3 * i];
        S[3 * b + 1] += cols[3 * i + 1];
        S[3 * b + 2] += cols[3 * i + 2];
    }
    let acc = 0;
    for (let b = 0; b < B; b++) {
        if (cnt[b]) acc += (S[3 * b] ** 2 + S[3 * b + 1] ** 2 + S[3 * b + 2] ** 2) / cnt[b];
    }
    return { err: sumSq - acc, tmin, tmax, span, cnt, S };
}

function nelderMead(fn: (p: number[]) => number, x0: number[], step: number, iters: number) {
    const pts = [x0, [x0[0] + step, x0[1]], [x0[0], x0[1] + step]].map((p) => ({
        p,
        v: fn(p),
    }));
    for (let it = 0; it < iters; it++) {
        pts.sort((a, b) => a.v - b.v);
        const w = pts[2];
        const c = [(pts[0].p[0] + pts[1].p[0]) / 2, (pts[0].p[1] + pts[1].p[1]) / 2];
        const r = [2 * c[0] - w.p[0], 2 * c[1] - w.p[1]];
        const fr = fn(r);
        if (fr < pts[0].v) {
            const e = [3 * c[0] - 2 * w.p[0], 3 * c[1] - 2 * w.p[1]];
            const fe = fn(e);
            pts[2] = fe < fr ? { p: e, v: fe } : { p: r, v: fr };
        } else if (fr < pts[1].v) {
            pts[2] = { p: r, v: fr };
        } else {
            const k = [(c[0] + w.p[0]) / 2, (c[1] + w.p[1]) / 2];
            const fk = fn(k);
            if (fk < w.v) pts[2] = { p: k, v: fk };
            else {
                for (let j = 1; j < 3; j++) {
                    const p = [(pts[0].p[0] + pts[j].p[0]) / 2, (pts[0].p[1] + pts[j].p[1]) / 2];
                    pts[j] = { p, v: fn(p) };
                }
            }
        }
    }
    pts.sort((a, b) => a.v - b.v);
    return pts[0];
}

function makeStops(prof: ColorProfile, mean: number[], B: number, o: Params) {
    const pts: { t: number; lab: number[]; rgb: [number, number, number] }[] = [];
    for (let b = 0; b < B; b++) {
        const c = prof.cnt[b];
        if (c < 2) continue;
        const L = mean[0] + prof.S[3 * b] / c,
            A = mean[1] + prof.S[3 * b + 1] / c,
            Bb = mean[2] + prof.S[3 * b + 2] / c;
        pts.push({
            t: (b + 0.5) / B,
            lab: [L, A, Bb],
            rgb: oklabToRgb01(L, A, Bb),
        });
    }
    if (pts.length < 2) return pts;
    const err = (i: number, j: number, k: number) => {
        const u = (pts[k].t - pts[i].t) / (pts[j].t - pts[i].t);
        const r = [0, 1, 2].map((c) => pts[i].rgb[c] + (pts[j].rgb[c] - pts[i].rgb[c]) * u);
        const l = rgb01ToOklab(r[0], r[1], r[2]);
        return Math.hypot(l[0] - pts[k].lab[0], l[1] - pts[k].lab[1], l[2] - pts[k].lab[2]);
    };
    const keep = [0, pts.length - 1];
    while (keep.length < o.maxStops) {
        let worst = 0,
            wk = -1;
        for (let q = 0; q + 1 < keep.length; q++) {
            for (let k = keep[q] + 1; k < keep[q + 1]; k++) {
                const e = err(keep[q], keep[q + 1], k);
                if (e > worst) {
                    worst = e;
                    wk = k;
                }
            }
        }
        if (worst < o.stopTol || wk < 0) break;
        keep.push(wk);
        keep.sort((a, b) => a - b);
    }
    return keep.map((k) => pts[k]);
}

/**
 * Pick the simplest fill that explains a region: flat color, else linear gradient,
 * else radial gradient. Returns the `fill` attribute value (and registers any gradient in ctx.defs).
 * Only interior pixels are used: boundary pixels are anti-aliased mixes of two regions.
 */
function fitFill(
    px: Int32Array,
    m: Uint8Array,
    bx: number,
    by: number,
    W: number,
    flatOnly: boolean,
    ctx: RenderContext
): string {
    const { p, w, lab, fmt, fmtT } = ctx;

    let inner: number[] = [];
    for (let j = 0; j < px.length; j++) {
        const i = px[j];
        const k = (((i / w) | 0) - by) * W + ((i % w) - bx);
        if (m[k - 1] && m[k + 1] && m[k - W] && m[k + W]) inner.push(i);
    }
    if (inner.length < 24) inner = Array.from(px);

    const stride = Math.max(1, Math.ceil(inner.length / 3000));
    const n = Math.ceil(inner.length / stride);
    const xs = new Float64Array(n),
        ys = new Float64Array(n),
        cols = new Float64Array(n * 3);
    const mean = [0, 0, 0];
    for (let j = 0; j < n; j++) {
        const i = inner[j * stride];
        xs[j] = (i % w) + 0.5;
        ys[j] = ((i / w) | 0) + 0.5;
        for (let c = 0; c < 3; c++) {
            cols[3 * j + c] = lab[3 * i + c];
            mean[c] += lab[3 * i + c];
        }
    }
    for (let c = 0; c < 3; c++) mean[c] /= n;
    let sumSq = 0;
    for (let j = 0; j < n; j++)
        for (let c = 0; c < 3; c++) {
            cols[3 * j + c] -= mean[c];
            sumSq += cols[3 * j + c] ** 2;
        }
    const rmseFlat = Math.sqrt(sumSq / n);
    const flat = hex(oklabToRgb01(mean[0], mean[1], mean[2]));
    if (flatOnly || n < 16 || rmseFlat < p.flatTol) return flat;

    const B = p.bins;
    const ts = new Float64Array(n);
    let mx = 0,
        my = 0;
    for (let j = 0; j < n; j++) {
        mx += xs[j];
        my += ys[j];
    }
    mx /= n;
    my /= n;

    let lin: { prof: ColorProfile; dx: number; dy: number; err: number } | null = null;
    {
        let sxx = 0,
            sxy = 0,
            syy = 0;
        const sxc = [0, 0, 0],
            syc = [0, 0, 0];
        for (let j = 0; j < n; j++) {
            const dx = xs[j] - mx,
                dy = ys[j] - my;
            sxx += dx * dx;
            sxy += dx * dy;
            syy += dy * dy;
            for (let c = 0; c < 3; c++) {
                sxc[c] += dx * cols[3 * j + c];
                syc[c] += dy * cols[3 * j + c];
            }
        }
        const det = sxx * syy - sxy * sxy;
        if (Math.abs(det) > 1e-9) {
            let m00 = 0,
                m01 = 0,
                m11 = 0;
            for (let c = 0; c < 3; c++) {
                const gx = (syy * sxc[c] - sxy * syc[c]) / det;
                const gy = (sxx * syc[c] - sxy * sxc[c]) / det;
                m00 += gx * gx;
                m01 += gx * gy;
                m11 += gy * gy;
            }
            if (m00 + m11 > 1e-14) {
                const th = 0.5 * Math.atan2(2 * m01, m00 - m11);
                const dx = Math.cos(th),
                    dy = Math.sin(th);
                for (let j = 0; j < n; j++) ts[j] = (xs[j] - mx) * dx + (ys[j] - my) * dy;
                const prof = binProfile(ts, cols, n, B, sumSq);
                lin = { prof, dx, dy, err: prof.err };
            }
        }
    }

    let rad: { prof: ColorProfile; cx: number; cy: number; err: number } | null = null;
    if (!lin || Math.sqrt(Math.max(0, lin.err) / n) > p.flatTol) {
        const evalAt = (c: number[]) => {
            for (let j = 0; j < n; j++) ts[j] = Math.hypot(xs[j] - c[0], ys[j] - c[1]);
            return binProfile(ts, cols, n, B, sumSq).err;
        };
        let iMax = 0,
            iMin = 0,
            size = 0;
        for (let j = 0; j < n; j++) {
            if (cols[3 * j] > cols[3 * iMax]) iMax = j;
            if (cols[3 * j] < cols[3 * iMin]) iMin = j;
            size = Math.max(size, Math.abs(xs[j] - mx), Math.abs(ys[j] - my));
        }
        let best: { p: number[]; v: number } | null = null;
        for (const s of [
            [mx, my],
            [xs[iMax], ys[iMax]],
            [xs[iMin], ys[iMin]],
        ]) {
            const r = nelderMead(evalAt, s, Math.max(2, size * 0.15), 45);
            if (!best || r.v < best.v) best = r;
        }
        if (best) {
            for (let j = 0; j < n; j++) ts[j] = Math.hypot(xs[j] - best.p[0], ys[j] - best.p[1]);
            const prof = binProfile(ts, cols, n, B, sumSq);
            rad = { prof, cx: best.p[0], cy: best.p[1], err: prof.err };
        }
    }

    const useRad = rad && (!lin || rad.err < lin.err / 1.1);
    const best = useRad ? rad! : lin;
    if (!best) return flat;
    const rmse = Math.sqrt(Math.max(0, best.err) / n);
    if (rmseFlat - rmse < p.flatTol * 0.35) return flat;

    const stops = makeStops(best.prof, mean, B, p);
    if (stops.length < 2) return flat;
    const id = "g" + ctx.gradCount++;
    const stopTags = (off: (t: number) => number) =>
        stops.map((s) => `<stop offset="${fmtT(off(s.t))}" stop-color="${hex(s.rgb)}"/>`).join("");
    const { tmin, tmax, span } = best.prof;
    if ("dx" in best) {
        const p1 = [mx + best.dx * tmin, my + best.dy * tmin];
        const p2 = [mx + best.dx * tmax, my + best.dy * tmax];
        ctx.defs.push(
            `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(p1[0])}" y1="${fmt(p1[1])}" x2="${fmt(p2[0])}" y2="${fmt(p2[1])}">` +
                stopTags((t) => t) +
                "</linearGradient>"
        );
    } else {
        if (tmax <= 0) return flat;
        ctx.defs.push(
            `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(best.cx)}" cy="${fmt(best.cy)}" r="${fmt(tmax)}">` +
                stopTags((t) => (tmin + t * span) / tmax) +
                "</radialGradient>"
        );
    }
    return `url(#${id})`;
}

/* ----------------------------------------------------------------- region */

/** Outline path of one ink component, traced from the soft coverage field. */
function inkPath(top: number, bx: number, by: number, W: number, H: number, ctx: RenderContext): string {
    const { p, w, h, soft, inkLabels, fmt } = ctx;
    const mm = new Uint8Array(W * H);
    const g = new Float32Array(W * H);
    const foreign = new Uint8Array(W * H);
    for (let ly = 1; ly < H - 1; ly++) {
        const gy = by + ly,
            cy = gy < 0 ? 0 : gy >= h ? h - 1 : gy;
        for (let lx = 1; lx < W - 1; lx++) {
            const gx = bx + lx,
                cx = gx < 0 ? 0 : gx >= w ? w - 1 : gx;
            const q = cy * w + cx,
                k = ly * W + lx;
            g[k] = soft[q];
            if (inkLabels[q] === top) mm[k] = 1;
            else if (inkLabels[q] >= 0) foreign[k] = 1;
        }
    }
    let dm = mm;
    for (let it = 0; it < 2; it++) {
        const nx = dm.slice();
        for (let ly = 1; ly < H - 1; ly++)
            for (let lx = 1; lx < W - 1; lx++) {
                const k = ly * W + lx;
                if (dm[k]) continue;
                if (
                    dm[k - 1] ||
                    dm[k + 1] ||
                    dm[k - W] ||
                    dm[k + W] ||
                    dm[k - W - 1] ||
                    dm[k - W + 1] ||
                    dm[k + W - 1] ||
                    dm[k + W + 1]
                )
                    nx[k] = 1;
            }
        dm = nx;
    }
    for (let k = 0; k < W * H; k++) if (!dm[k] || foreign[k]) g[k] = 0;
    return fieldToPath(g, W, H, bx, by, p, fmt);
}

function processRegion(px: Int32Array, top: number, isInk: boolean, out: PathItem[], ctx: RenderContext): void {
    const { p, w, h, labels, ink, fmt, rank } = ctx;
    let x0 = w,
        y0 = h,
        x1 = -1,
        y1 = -1;
    for (let j = 0; j < px.length; j++) {
        const x = px[j] % w,
            y = (px[j] / w) | 0;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    const P = p.expand + 4;
    const bx = x0 - P,
        by = y0 - P;
    const W = x1 - x0 + 1 + 2 * P,
        H = y1 - y0 + 1 + 2 * P;
    const m0 = new Uint8Array(W * H);
    for (let j = 0; j < px.length; j++) m0[(((px[j] / w) | 0) - by) * W + ((px[j] % w) - bx)] = 1;

    const fill = fitFill(px, m0, bx, by, W, isInk, ctx);
    if (isInk) {
        const d = inkPath(top, bx, by, W, H, ctx);
        if (d) out.push({ d, fill });
        return;
    }

    let m = m0;
    for (let it = 0; it < p.expand; it++) {
        const nx = m.slice();
        for (let ly = 1; ly < H - 1; ly++) {
            const gy = by + ly;
            if (gy < 0 || gy >= h) continue;
            for (let lx = 1; lx < W - 1; lx++) {
                const k = ly * W + lx;
                if (m[k]) continue;
                const gx = bx + lx;
                if (gx < 0 || gx >= w) continue;
                const g = gy * w + gx;
                const lg = labels[g];
                if (!(ink[g] || lg === top || (lg >= 0 && rank[lg] > rank[top]))) continue;
                if (m[k - 1] || m[k + 1] || m[k - W] || m[k + W]) nx[k] = 1;
            }
        }
        m = nx;
    }
    const d = maskToPath(m, W, H, bx, by, w, h, p, fmt);
    if (d) out.push({ d, fill });
}

/* ------------------------------------------------------------------- main */

export function imageDataToSVG(input: ImageDataLike, opts?: SVGOptions): string {
    const o = resolveOptions(opts);
    const outW = input.width,
        outH = input.height;
    const f = Math.max(outW, outH) / o.maxSize;
    const img = f > 1 ? boxDownscale(input, f) : input;
    const w = img.width,
        h = img.height,
        n = w * h,
        data = img.data;
    const p = derive(o, w, h);

    const lab = new Float32Array(n * 3);
    const solid = new Uint8Array(n);
    const ink = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        if (data[i * 4 + 3] < o.alphaCutoff) continue;
        solid[i] = 1;
        linToOklab(S2L[data[i * 4]], S2L[data[i * 4 + 1]], S2L[data[i * 4 + 2]], lab, i * 3);
        if (lab[i * 3] < o.inkL) ink[i] = 1;
    }
    {
        const r = labelComponents(ink, w, h, true);
        for (let i = 0; i < n; i++) if (r.labels[i] >= 0 && r.sizes[r.labels[i]] < p.minRegionArea) ink[i] = 0;
    }

    const grad = new Float32Array(n);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!solid[i] || ink[i]) continue;
            const xl = x > 0 && solid[i - 1] ? i - 1 : i,
                xr = x < w - 1 && solid[i + 1] ? i + 1 : i,
                yu = y > 0 && solid[i - w] ? i - w : i,
                yd = y < h - 1 && solid[i + w] ? i + w : i;
            let g2 = 0;
            for (let c = 0; c < 3; c++) {
                const gx = (lab[xr * 3 + c] - lab[xl * 3 + c]) / 2,
                    gy = (lab[yd * 3 + c] - lab[yu * 3 + c]) / 2;
                g2 += gx * gx + gy * gy;
            }
            grad[i] = Math.sqrt(g2);
        }
    {
        const samp: number[] = [];
        for (let i = 0; i < n; i += 5) if (solid[i] && !ink[i]) samp.push(grad[i]);
        samp.sort((a, b) => a - b);
        if (samp.length) p.edgeT = Math.max(p.edgeT, 5 * samp[samp.length >> 1]);
    }

    const core = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (solid[i] && !ink[i] && grad[i] <= p.edgeT) core[i] = 1;
    const reg = labelComponents(core, w, h, false);
    for (let i = 0; i < n; i++) {
        const l = reg.labels[i];
        if (l >= 0 && reg.sizes[l] < p.minRegionArea) reg.labels[i] = -1;
    }

    {
        const cntL = new Float64Array(reg.count),
            sumL = new Float64Array(reg.count * 3);
        for (let i = 0; i < n; i++) {
            const l = reg.labels[i];
            if (l < 0) continue;
            cntL[l]++;
            for (let c = 0; c < 3; c++) sumL[l * 3 + c] += lab[i * 3 + c];
        }
        for (let l = 0; l < reg.count; l++) if (cntL[l]) for (let c = 0; c < 3; c++) sumL[l * 3 + c] /= cntL[l];
        const isFree = (r: number): boolean => Boolean(solid[r]) && !ink[r] && reg.labels[r] === -1;
        const nbrs = (q: number): number[] => {
            const x = q % w;
            return [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, q >= w ? q - w : -1, q < n - w ? q + w : -1];
        };
        let frontier: number[] = [];
        const queued = new Uint8Array(n);
        for (let i = 0; i < n; i++)
            if (reg.labels[i] >= 0)
                for (const r of nbrs(i))
                    if (r >= 0 && isFree(r) && !queued[r]) {
                        queued[r] = 1;
                        frontier.push(r);
                    }
        while (frontier.length) {
            const pick = new Int32Array(frontier.length);
            for (let k = 0; k < frontier.length; k++) {
                const q = frontier[k];
                let bl = -1,
                    bd = Infinity;
                for (const r of nbrs(q)) {
                    if (r < 0) continue;
                    const l = reg.labels[r];
                    if (l < 0) continue;
                    const d =
                        (lab[q * 3] - sumL[l * 3]) ** 2 +
                        (lab[q * 3 + 1] - sumL[l * 3 + 1]) ** 2 +
                        (lab[q * 3 + 2] - sumL[l * 3 + 2]) ** 2;
                    if (d < bd) {
                        bd = d;
                        bl = l;
                    }
                }
                pick[k] = bl;
            }
            const next: number[] = [];
            for (let k = 0; k < frontier.length; k++) reg.labels[frontier[k]] = pick[k];
            for (const q of frontier)
                for (const r of nbrs(q))
                    if (r >= 0 && isFree(r) && !queued[r]) {
                        queued[r] = 1;
                        next.push(r);
                    }
            frontier = next;
        }
    }
    const inkC = labelComponents(ink, w, h, true);

    const soft = new Float32Array(n);
    {
        const samp: number[] = [];
        for (let i = 0; i < n; i += 7) if (ink[i]) samp.push(lab[i * 3]);
        samp.sort((a, b) => a - b);
        const inkLo = samp.length ? samp[samp.length >> 1] : 0.12;
        const R = 2;
        const hm = new Float32Array(n);
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                let mxv = -1;
                for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) {
                    const i = y * w + xx;
                    if (solid[i] && lab[i * 3] > mxv) mxv = lab[i * 3];
                }
                hm[y * w + x] = mxv;
            }
        for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (!solid[i]) continue;
                if (ink[i]) {
                    soft[i] = 1;
                    continue;
                }
                let hi = -1;
                for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++)
                    if (hm[yy * w + x] > hi) hi = hm[yy * w + x];
                const span = hi - inkLo;
                if (span < 0.08) continue;
                const c = (hi - lab[i * 3]) / span;
                soft[i] = c < 0 ? 0 : c > 1 ? 1 : c;
            }
    }

    const rank = new Int32Array(reg.count).fill(1 << 30);
    const regionLists = groupPixels(reg.labels, reg.count)
        .map((px, label) => ({ px, label }))
        .filter((r) => r.px.length >= p.minRegionArea)
        .sort((a, b) => b.px.length - a.px.length);
    regionLists.forEach((r, k) => (rank[r.label] = k));
    const inkLists = groupPixels(inkC.labels, inkC.count)
        .map((px, label) => ({ px, label }))
        .filter((r) => r.px.length > 0)
        .sort((a, b) => b.px.length - a.px.length);

    const ctx: RenderContext = {
        p,
        w,
        h,
        lab,
        ink,
        soft,
        inkLabels: inkC.labels,
        labels: reg.labels,
        fmt: makeFmt(Math.max(w, h) >= 600 ? 1 : 2),
        fmtT: makeFmt(3),
        defs: [],
        gradCount: 0,
        rank,
    };

    const items: PathItem[] = [];
    for (const r of regionLists) processRegion(r.px, r.label, false, items, ctx);
    for (const r of inkLists) processRegion(r.px, r.label, true, items, ctx);

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${outW}" height="${outH}">`;
    if (ctx.defs.length) svg += "<defs>" + ctx.defs.join("") + "</defs>";
    svg += '<g fill-rule="evenodd">';
    for (const it of items) svg += `<path d="${it.d}" fill="${it.fill}"/>`;
    return svg + "</g></svg>";
}

export default imageDataToSVG;
