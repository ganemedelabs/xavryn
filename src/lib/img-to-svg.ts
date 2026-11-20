/**
 * img-to-svg.ts
 *
 * Converts an ImageData (RGBA) into an SVG string with smooth Bézier paths and
 * fitted linear / radial gradients, instead of posterized color bands.
 *
 * Pipeline:
 *   1. Convert to OKLab. "Ink" = solid dark pixels (outlines, black spots).
 *      Dark-but-not-black areas (e.g. dark hair) are NOT ink; they are regions.
 *   2. Find hard edges (abrupt colour change). Flat areas between edges and ink
 *      become regions. Edge pixels join the neighbouring region whose colour they
 *      match best, so boundaries sit where the colour really flips.
 *   3. Per region: fit flat / linear gradient / radial gradient (OKLab residual),
 *      reduce the colour profile to a few stops.
 *   4. If a region still has clearly mis-fitted areas (strong residual), those
 *      are refit as their own patches painted on top (recursive).
 *   5. Trace each region at subpixel precision (marching squares), detect
 *      corners, fit cubic Béziers (Schneider). Ink outlines are traced from a soft
 *      coverage field, so line thickness is right even for thin strokes.
 *   6. Paint largest region first. Each region is grown underneath whatever is
 *      painted after it (and under the ink), so no seams show.
 */

export interface SVGOptions {
    maxSize?: number;
    alphaCutoff?: number;
    inkL?: number;
    minRegionArea?: number;
    expand?: number;
    flatTol?: number;
    splitTol?: number;
    maxDepth?: number;
    minSplitArea?: number;
    bins?: number;
    stopTol?: number;
    maxStops?: number;
    curveTol?: number;
    cornerAngle?: number;
    cornerWindow?: number;
    minRingArea?: number;
    precision?: number;
    patchCore?: number;
    patchEdge?: number;
    patchMin?: number;
    edgeT?: number;
    softBlobs?: number;
    softSpread?: number;
    meshCells?: number;
    meshBlur?: number;
    meshTol?: number;
    patchFeather?: number;
}

type RequiredSVGOptions = Required<SVGOptions>;

interface ImageDataLike {
    data: Uint8ClampedArray | Uint8Array;
    width: number;
    height: number;
}

interface PathItem {
    d: string;
    fill: string;
    /** Extra markup painted right after the path (soft blob layers, clipped to the path). */
    extra?: string;
    /** Soft edge (blur sigma in px) for refinement patches, so they melt into what is underneath. */
    feather?: number;
    /** Mask bounding box [x, y, w, h]; the feather filter region is derived from it. */
    box?: [number, number, number, number];
}

interface RenderContext {
    o: RequiredSVGOptions;
    w: number;
    h: number;
    lab: Float32Array;
    ink: Uint8Array;
    soft: Float32Array;
    inkLabels: Int32Array;
    labels: Int32Array;
    fmt: (v: number) => string;
    defs: string[];
    gradCount: number;
    rank?: Int32Array;
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
            "Longest side, in pixels, of the working image. Larger inputs are box-downscaled to this size before analysis; the SVG viewBox follows the working size while width/height keep the original size. Higher = more detail but slower and more memory.",
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
            "OKLab lightness below which a pixel counts as solid 'ink' (outlines, black spots). Ink is traced as its own top layer. Dark-but-not-black areas such as dark hair should stay above this so they remain gradient regions. Raise it to treat more dark colors as ink.",
    },
    minRegionArea: {
        label: "Min region area",
        default: 12,
        min: 1,
        max: 500,
        integer: true,
        description:
            "Smallest region or ink component, in pixels, that is kept. Smaller components are dropped or absorbed into a neighbour. Raise it to remove specks and noise, lower it to keep tiny details.",
    },
    expand: {
        label: "Overlap",
        default: 2,
        min: 0,
        max: 8,
        integer: true,
        description:
            "How many pixels each region is grown underneath the regions painted after it (and under the ink). Hides anti-aliasing seams between neighbouring shapes. Too high wastes work, 0 may show hairline gaps.",
    },
    flatTol: {
        label: "Flat fill tolerance",
        default: 0.012,
        min: 0,
        max: 0.1,
        description:
            "OKLab RMS error below which a region is painted as a single flat color instead of a gradient. Raise it for fewer gradients and smaller files, lower it to keep subtle shading.",
    },
    splitTol: {
        label: "Split tolerance",
        default: 0.035,
        min: 0,
        max: 0.2,
        description:
            "OKLab RMS error above which a poorly fitted region, with no clear patches to refit, is split in two by 2-means clustering and each half is refit.",
    },
    maxDepth: {
        label: "Refinement depth",
        default: 3,
        min: 0,
        max: 6,
        integer: true,
        description:
            "Maximum number of recursive refinements (patches or splits painted on top of a region). 0 disables refinement entirely. Higher = more accurate highlights and shading but more paths.",
    },
    minSplitArea: {
        label: "Min refine area",
        default: 150,
        min: 1,
        max: 10000,
        integer: true,
        description:
            "Regions smaller than this many pixels are never refined or split. Raise it to keep small regions simple.",
    },
    bins: {
        label: "Gradient bins",
        default: 32,
        min: 4,
        max: 128,
        integer: true,
        description:
            "Number of bins in the 1D color profile used to fit gradient stops. More bins follow the shading more closely but are noisier on small regions.",
    },
    stopTol: {
        label: "Stop tolerance",
        default: 0.008,
        min: 0,
        max: 0.1,
        description:
            "Maximum OKLab error allowed when dropping gradient stops. Raise it for fewer stops and smaller files, lower it for smoother, more faithful gradients.",
    },
    maxStops: {
        label: "Max gradient stops",
        default: 6,
        min: 2,
        max: 16,
        integer: true,
        description: "Maximum number of color stops in a single gradient.",
    },
    curveTol: {
        label: "Curve tolerance",
        default: 0.8,
        min: 0.1,
        max: 5,
        description:
            "Bezier fitting tolerance in pixels. Lower = paths follow the shape more tightly (more segments), higher = smoother, simpler paths.",
    },
    cornerAngle: {
        label: "Corner angle",
        default: 50,
        min: 10,
        max: 170,
        description:
            "Turning angle in degrees above which a point on an outline is kept as a sharp corner instead of being smoothed. Lower = more corners, higher = rounder shapes.",
    },
    cornerWindow: {
        label: "Corner window",
        default: 4,
        min: 2,
        max: 12,
        integer: true,
        description:
            "Number of outline points on each side used to measure the turning angle when detecting corners. Larger values ignore pixel-level jitter but can miss tight corners.",
    },
    minRingArea: {
        label: "Min contour area",
        default: 3,
        min: 0,
        max: 100,
        description:
            "Contours enclosing less than this area (in px²) are dropped from the path data. Raise it to discard tiny holes and islands.",
    },
    precision: {
        label: "Decimal precision",
        default: 2,
        min: 0,
        max: 6,
        integer: true,
        description:
            "Number of decimals written in path coordinates and gradient values. Lower = smaller files, higher = more exact geometry.",
    },
    patchCore: {
        label: "Patch threshold",
        default: 0.03,
        min: 0.01,
        max: 0.5,
        description:
            "OKLab error at which a pixel counts as clearly mis-fitted by its region's gradient. Such pixels seed a patch that is refit and painted on top. Lower = more patches (more detail, more paths).",
    },
    patchEdge: {
        label: "Patch spread",
        default: 0.012,
        min: 0.005,
        max: 0.5,
        description:
            "A patch grows outward from its seed pixels until the error falls below this value, so its seam with the parent region is invisible. Should be lower than patchCore.",
    },
    patchMin: {
        label: "Min patch size",
        default: 30,
        min: 1,
        max: 500,
        integer: true,
        description:
            "Minimum number of seed pixels (error above patchCore) a patch needs to be created. Raise it to ignore small mis-fitted spots.",
    },
    edgeT: {
        label: "Edge threshold",
        default: 0.02,
        min: 0.002,
        max: 0.2,
        description:
            "OKLab color change per pixel above which a pixel is a hard edge. Hard edges separate regions, so highlights, strands and shapes get their own region. Lower = more, smaller regions (more detail, risk of fragmenting noisy images). Higher = fewer, larger regions.",
    },
    softBlobs: {
        label: "Soft blobs",
        default: 24,
        min: 0,
        max: 128,
        integer: true,
        description:
            "Maximum number of soft, feathered color blobs layered on top of a region's base gradient to reproduce smooth multi-color shading (mesh-gradient look). Blobs fade to transparent at their rim and are clipped to the region, so they never show seams. 0 disables this and falls back to hard-edged patches/splits.",
    },
    softSpread: {
        label: "Soft spread",
        default: 1.6,
        min: 0.8,
        max: 4,
        description:
            "Blob radius relative to the grid cell it was fitted on. Higher = wider, softer, more overlapping blends; lower = tighter, more local color spots.",
    },
    meshCells: {
        label: "Mesh grid size",
        default: 16,
        min: 0,
        max: 64,
        integer: true,
        description:
            "Max grid cells along the longer side of a region for blurred colour-mesh shading. 0 disables it (falls back to soft blobs). The grid starts coarse and is refined until Mesh tolerance is met.",
    },
    meshBlur: {
        label: "Mesh blur",
        default: 0.7,
        min: 0.4,
        max: 1.5,
        description: "Gaussian blur radius in grid cells. Higher = smoother blends, lower = more local colour control.",
    },
    meshTol: {
        label: "Mesh tolerance",
        default: 0.01,
        min: 0.002,
        max: 0.1,
        description: "RMS error (sRGB, 0-1) at which the grid stops being refined.",
    },
    patchFeather: {
        label: "Patch feather",
        default: 5,
        min: 0,
        max: 20,
        description:
            "Blur sigma, in pixels, applied to the edge of refinement patches (hard-edged shapes painted over the mesh). Higher = patches melt into the surrounding shading, lower = crisper edges. 0 keeps them hard.",
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

function ringToBeziers(ring: number[][], o: RequiredSVGOptions): number[][][] | null {
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

    const tolSq = o.curveTol * o.curveTol;
    const out: number[][][] = [];
    for (let q = 0; q < breaks.length; q++) {
        const A = breaks[q],
            B = breaks[(q + 1) % breaks.length];
        const seg = [];
        let i = A.i;
        do {
            seg.push(ring[i]);
            i = (i + 1) % n;
        } while (i !== B.i);
        seg.push(ring[B.i]);
        const kt = Math.min(k + 1, seg.length - 1);
        const t1 = A.corner ? unit(sub(seg[kt], seg[0])) : unit(sub(ring[(A.i + k) % n], ring[(A.i - k + n) % n]));
        const t2 = B.corner
            ? unit(sub(seg[seg.length - 1 - kt], seg[seg.length - 1]))
            : unit(sub(ring[(B.i - k + n) % n], ring[(B.i + k) % n]));
        fitCubic(seg, t1, t2, tolSq, out);
    }
    return out;
}

function makeFmt(p: number): (v: number) => string {
    return (v: number) => {
        const s = v.toFixed(p);
        if (s.indexOf(".") < 0) return s;
        const t = s.replace(/\.?0+$/, "");
        return t === "-0" || t === "" ? "0" : t;
    };
}

function beziersToPath(bz: number[][][], fmt: (v: number) => string): string {
    let d = "M" + fmt(bz[0][0][0]) + " " + fmt(bz[0][0][1]);
    for (const b of bz) {
        d +=
            "C" +
            fmt(b[1][0]) +
            " " +
            fmt(b[1][1]) +
            " " +
            fmt(b[2][0]) +
            " " +
            fmt(b[2][1]) +
            " " +
            fmt(b[3][0]) +
            " " +
            fmt(b[3][1]);
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
    o: RequiredSVGOptions,
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
    o: RequiredSVGOptions,
    fmt: (v: number) => string
): string {
    const rings = contourRings(f, W, H, bx, by, 0.5);
    let d = "";
    for (const ring of rings) {
        if (ring.length < 4 || ringArea(ring) < o.minRingArea) continue;
        const bz = ringToBeziers(ring, o);
        if (bz && bz.length) d += beziersToPath(bz, fmt);
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

function makeStops(prof: ColorProfile, mean: number[], B: number, o: RequiredSVGOptions) {
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

function analyze(px: Int32Array, m: Uint8Array, bx: number, by: number, W: number, ctx: RenderContext) {
    const { o, w, lab } = ctx;

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
    for (let j = 0; j < n; j++) {
        for (let c = 0; c < 3; c++) {
            cols[3 * j + c] -= mean[c];
            sumSq += cols[3 * j + c] ** 2;
        }
    }
    const rmseFlat = Math.sqrt(sumSq / n);
    const flat = {
        fill: hex(oklabToRgb01(mean[0], mean[1], mean[2])),
        rmse: rmseFlat,
        errAt: (i: number) => Math.hypot(lab[3 * i] - mean[0], lab[3 * i + 1] - mean[1], lab[3 * i + 2] - mean[2]),
        colAt: (_i: number): number[] => mean, // eslint-disable-line @typescript-eslint/no-unused-vars
    };
    if (n < 16 || rmseFlat < o.flatTol) return flat;

    const B = o.bins;
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
    {
        const evalAt = (c: number[]) => {
            for (let j = 0; j < n; j++) ts[j] = Math.hypot(xs[j] - c[0], ys[j] - c[1]);
            return binProfile(ts, cols, n, B, sumSq).err;
        };
        let iMax = 0,
            iMin = 0;
        for (let j = 0; j < n; j++) {
            if (cols[3 * j] > cols[3 * iMax]) iMax = j;
            if (cols[3 * j] < cols[3 * iMin]) iMin = j;
        }
        let size = 0;
        for (let j = 0; j < n; j++) size = Math.max(size, Math.abs(xs[j] - mx), Math.abs(ys[j] - my));
        let bestPos: number[] | null = null;
        for (const s of [
            [mx, my],
            [xs[iMax], ys[iMax]],
            [xs[iMin], ys[iMin]],
        ]) {
            const r = nelderMead(evalAt, s, Math.max(2, size * 0.15), 45);
            if (!bestPos || evalAt(r.p) < evalAt(bestPos)) bestPos = r.p;
        }
        if (bestPos) {
            for (let j = 0; j < n; j++) ts[j] = Math.hypot(xs[j] - bestPos[0], ys[j] - bestPos[1]);
            const prof = binProfile(ts, cols, n, B, sumSq);
            rad = { prof, cx: bestPos[0], cy: bestPos[1], err: prof.err };
        }
    }

    const cands = [lin && { kind: "lin", ...lin }, rad && { kind: "rad", ...rad }].filter(Boolean) as Array<{
        kind: string;
        prof: ColorProfile;
        err: number;
        dx?: number;
        dy?: number;
        cx?: number;
        cy?: number;
    }>;
    cands.sort((a, b) => a.err - b.err);
    let best = cands[0];
    if (best && best.kind === "rad" && lin && lin.err < best.err * 1.1) {
        const foundLin = cands.find((c) => c.kind === "lin");
        if (foundLin) best = foundLin;
    }
    if (!best) return flat;

    const rmse = Math.sqrt(Math.max(0, best.err) / n);
    if (rmseFlat - rmse < 0.004) return flat;

    const stops = makeStops(best.prof, mean, B, o);
    if (stops.length < 2) return flat;
    const id = "g" + ctx.gradCount++;
    let def = "";
    const fmt = ctx.fmt;
    if (best.kind === "lin" && best.dx !== undefined && best.dy !== undefined) {
        const { tmin, tmax } = best.prof;
        const p1 = [mx + best.dx * tmin, my + best.dy * tmin];
        const p2 = [mx + best.dx * tmax, my + best.dy * tmax];
        def =
            `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${fmt(p1[0])}" y1="${fmt(p1[1])}" x2="${fmt(p2[0])}" y2="${fmt(p2[1])}">` +
            stops.map((s) => `<stop offset="${fmt(s.t)}" stop-color="${hex(s.rgb)}"/>`).join("") +
            "</linearGradient>";
    } else if (best.kind === "rad" && best.cx !== undefined && best.cy !== undefined) {
        const { tmin, tmax, span } = best.prof;
        if (tmax <= 0) return flat;
        def =
            `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(best.cx)}" cy="${fmt(best.cy)}" r="${fmt(tmax)}">` +
            stops
                .map((s) => `<stop offset="${fmt((tmin + s.t * span) / tmax)}" stop-color="${hex(s.rgb)}"/>`)
                .join("") +
            "</radialGradient>";
    }
    ctx.defs.push(def);

    const { tmin, span } = best.prof;
    const LUT = new Float32Array(256 * 3);
    for (let q = 0; q < 256; q++) {
        const t = q / 255;
        let a = stops[0],
            b = stops[stops.length - 1];
        if (t <= a.t) b = a;
        else if (t >= b.t) a = b;
        else
            for (let k = 0; k + 1 < stops.length; k++)
                if (t >= stops[k].t && t <= stops[k + 1].t) {
                    a = stops[k];
                    b = stops[k + 1];
                    break;
                }
        const u = a === b ? 0 : (t - a.t) / (b.t - a.t);
        const l = rgb01ToOklab(
            a.rgb[0] + (b.rgb[0] - a.rgb[0]) * u,
            a.rgb[1] + (b.rgb[1] - a.rgb[1]) * u,
            a.rgb[2] + (b.rgb[2] - a.rgb[2]) * u
        );
        LUT[3 * q] = l[0];
        LUT[3 * q + 1] = l[1];
        LUT[3 * q + 2] = l[2];
    }
    const isLin = best.kind === "lin";
    const colAt = (i: number): number[] => {
        const x = (i % w) + 0.5,
            y = ((i / w) | 0) + 0.5;
        const t =
            isLin && best.dx !== undefined && best.dy !== undefined
                ? (x - mx) * best.dx + (y - my) * best.dy
                : best.cx !== undefined && best.cy !== undefined
                  ? Math.hypot(x - best.cx, y - best.cy)
                  : 0;
        let q = (((t - tmin) / span) * 255 + 0.5) | 0;
        q = q < 0 ? 0 : q > 255 ? 255 : q;
        return [LUT[3 * q], LUT[3 * q + 1], LUT[3 * q + 2]];
    };
    const errAt = (i: number) => {
        const c = colAt(i);
        return Math.hypot(lab[3 * i] - c[0], lab[3 * i + 1] - c[1], lab[3 * i + 2] - c[2]);
    };
    return { fill: `url(#${id})`, rmse, errAt, colAt };
}

/* ------------------------------------------------------------ soft layers */

/**
 * Smooth multi-color shading ("mesh gradient" look) for one region.
 *
 * SVG has no mesh gradient, so we approximate it with feathered blobs: radial
 * gradients whose color is opaque in the middle and fades to transparent at the rim,
 * stacked on the region's base fill and clipped to the region outline.
 *
 * Greedy matching pursuit, coarse to fine: simulate what is painted so far, find the
 * grid cell where the image differs most from it, drop a blob there with the cell's
 * true color, update the simulation, repeat. Early blobs are big (broad color areas),
 * later ones small (local tweaks).
 */
function softLayers(
    px: Int32Array,
    fit: { colAt: (i: number) => number[]; rmse: number },
    clipD: string,
    m: Uint8Array,
    bx: number,
    by: number,
    W: number,
    ctx: RenderContext
): string {
    const { o, w, lab, fmt } = ctx;
    // Only fit interior pixels: boundary pixels are anti-aliased mixes of two regions
    // and would drag blobs towards colors that don't belong to this region.
    let src: ArrayLike<number> = px;
    {
        const inner: number[] = [];
        for (let j = 0; j < px.length; j++) {
            const i = px[j];
            const k = (((i / w) | 0) - by) * W + ((i % w) - bx);
            if (m[k - 1] && m[k + 1] && m[k - W] && m[k + W]) inner.push(i);
        }
        if (inner.length >= 24) src = inner;
    }
    const stride = Math.max(1, Math.ceil(src.length / 4000));
    const n = Math.ceil(src.length / stride);
    const xs = new Float32Array(n),
        ys = new Float32Array(n),
        tgt = new Float32Array(n * 3),
        cur = new Float32Array(n * 3);
    let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
    for (let j = 0; j < n; j++) {
        const i = src[j * stride];
        xs[j] = (i % w) + 0.5;
        ys[j] = ((i / w) | 0) + 0.5;
        const c = fit.colAt(i);
        for (let k = 0; k < 3; k++) {
            tgt[3 * j + k] = lab[3 * i + k];
            cur[3 * j + k] = c[k];
        }
        if (xs[j] < x0) x0 = xs[j];
        if (xs[j] > x1) x1 = xs[j];
        if (ys[j] < y0) y0 = ys[j];
        if (ys[j] > y1) y1 = ys[j];
    }
    const size = Math.max(x1 - x0, y1 - y0, 1);
    // Small regions need few blobs; the budget grows with the region's size.
    const K = Math.max(1, Math.min(o.softBlobs, Math.round(Math.sqrt(src.length) / 8)));
    // Opacity falloff across the blob radius: raised cosine, 0 at the rim.
    const OFFS = [0, 0.25, 0.5, 0.75, 1];
    const fall = (t: number): number => (t >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * t)));

    let markup = "";
    let fails = 0;
    for (let k = 0; k < K; k++) {
        const cell = size / (4 + (10 * k) / K);
        const gw = Math.floor((x1 - x0) / cell) + 1,
            gh = Math.floor((y1 - y0) / cell) + 1;
        const cnt = new Float64Array(gw * gh),
            res = new Float64Array(gw * gh * 3),
            tg = new Float64Array(gw * gh * 3),
            sx = new Float64Array(gw * gh),
            sy = new Float64Array(gw * gh);
        for (let j = 0; j < n; j++) {
            const g = Math.floor((ys[j] - y0) / cell) * gw + Math.floor((xs[j] - x0) / cell);
            cnt[g]++;
            sx[g] += xs[j];
            sy[g] += ys[j];
            for (let c = 0; c < 3; c++) {
                res[3 * g + c] += tgt[3 * j + c] - cur[3 * j + c];
                tg[3 * g + c] += tgt[3 * j + c];
            }
        }
        // Cell with the biggest average error; sqrt(count) keeps tiny edge cells from winning.
        let best = -1,
            bestScore = 0,
            bestMag = 0;
        for (let g = 0; g < cnt.length; g++) {
            if (cnt[g] < 3) continue;
            const mag = Math.hypot(res[3 * g], res[3 * g + 1], res[3 * g + 2]) / cnt[g];
            const score = mag * Math.sqrt(cnt[g]);
            if (score > bestScore) {
                bestScore = score;
                best = g;
                bestMag = mag;
            }
        }
        if (best < 0 || bestMag < o.flatTol) break;

        const cx = sx[best] / cnt[best],
            cy = sy[best] / cnt[best];
        const R = cell * o.softSpread;
        // Least-squares blob color: minimises sum |target - (cur + a*(col - cur))|^2 over
        // the blob's footprint, where a is the blob's opacity at each pixel.
        const num = [0, 0, 0];
        let den = 0;
        for (let j = 0; j < n; j++) {
            const t = Math.hypot(xs[j] - cx, ys[j] - cy) / R;
            if (t >= 1) continue;
            const a = fall(t);
            den += a * a;
            for (let c = 0; c < 3; c++) num[c] += a * (tgt[3 * j + c] - cur[3 * j + c] + a * cur[3 * j + c]);
        }
        if (den < 1e-9) {
            if (++fails >= 3) break;
            continue;
        }
        const col = [num[0] / den, num[1] / den, num[2] / den];
        // Apply to a trial copy; keep the blob only if the total error really drops.
        const trial = cur.slice();
        let gain = 0;
        for (let j = 0; j < n; j++) {
            const t = Math.hypot(xs[j] - cx, ys[j] - cy) / R;
            if (t >= 1) continue;
            const a = fall(t);
            let before = 0,
                after = 0;
            for (let c = 0; c < 3; c++) {
                const nv = cur[3 * j + c] + (col[c] - cur[3 * j + c]) * a;
                trial[3 * j + c] = nv;
                before += (tgt[3 * j + c] - cur[3 * j + c]) ** 2;
                after += (tgt[3 * j + c] - nv) ** 2;
            }
            gain += before - after;
        }
        if (gain <= 1e-6) {
            if (++fails >= 3) break;
            continue;
        }
        fails = 0;
        cur.set(trial);

        const id = "s" + ctx.gradCount++;
        const rgb = hex(oklabToRgb01(col[0], col[1], col[2]));
        ctx.defs.push(
            `<radialGradient id="${id}">` +
                OFFS.map(
                    (t) =>
                        `<stop offset="${t}" stop-color="${rgb}"` +
                        (fall(t) < 1 ? ` stop-opacity="${fmt(fall(t))}"` : "") +
                        "/>"
                ).join("") +
                "</radialGradient>"
        );
        markup += `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(R)}" fill="url(#${id})"/>`;
    }
    if (!markup) return "";
    const cid = "c" + ctx.gradCount++;
    ctx.defs.push(`<clipPath id="${cid}"><path d="${clipD}" clip-rule="evenodd"/></clipPath>`);
    return `<g clip-path="url(#${cid})">${markup}</g>`;
}

function erf(x: number): number {
    const sgn = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const p = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
    return sgn * (1 - p * Math.exp(-x * x));
}
const Phi = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

/** Weights of a Gaussian (sigma in cells) integrated over unit-wide cells. */
function gaussKernel(sigma: number): { ker: Float64Array; R: number } {
    const R = Math.max(1, Math.ceil(3 * sigma));
    const ker = new Float64Array(2 * R + 1);
    let sum = 0;
    for (let k = -R; k <= R; k++) {
        const v = Phi((k + 0.5) / sigma) - Phi((k - 0.5) / sigma);
        ker[k + R] = v;
        sum += v;
    }
    for (let k = 0; k < ker.length; k++) ker[k] /= sum;
    return { ker, R };
}

/** Separable blur of a gw x gh x 3 grid, edge cells replicated (matches the padded render). */
function blurGrid(src: Float64Array, gw: number, gh: number, ker: Float64Array, R: number): Float64Array {
    const tmp = new Float64Array(src.length);
    const out = new Float64Array(src.length);
    for (let y = 0; y < gh; y++)
        for (let x = 0; x < gw; x++)
            for (let c = 0; c < 3; c++) {
                let s = 0;
                for (let k = -R; k <= R; k++) {
                    const xx = Math.min(gw - 1, Math.max(0, x + k));
                    s += ker[k + R] * src[(y * gw + xx) * 3 + c];
                }
                tmp[(y * gw + x) * 3 + c] = s;
            }
    for (let y = 0; y < gh; y++)
        for (let x = 0; x < gw; x++)
            for (let c = 0; c < 3; c++) {
                let s = 0;
                for (let k = -R; k <= R; k++) {
                    const yy = Math.min(gh - 1, Math.max(0, y + k));
                    s += ker[k + R] * tmp[(yy * gw + x) * 3 + c];
                }
                out[(y * gw + x) * 3 + c] = s;
            }
    return out;
}

/** Value of the blurred grid at (u, v), in cell units (cell j spans [j, j+1]). */
function fieldAt(
    c: Float64Array,
    gw: number,
    gh: number,
    u: number,
    v: number,
    sigma: number,
    R: number,
    out: number[]
): void {
    const fu = Math.floor(u),
        fv = Math.floor(v);
    const n = 2 * R + 3;
    const wx = new Float64Array(n),
        wy = new Float64Array(n);
    let sx = 0,
        sy = 0;
    for (let k = 0; k < n; k++) {
        const j = fu - R - 1 + k,
            q = fv - R - 1 + k;
        wx[k] = Phi((j + 1 - u) / sigma) - Phi((j - u) / sigma);
        wy[k] = Phi((q + 1 - v) / sigma) - Phi((q - v) / sigma);
        sx += wx[k];
        sy += wy[k];
    }
    out[0] = out[1] = out[2] = 0;
    for (let a = 0; a < n; a++) {
        const jy = Math.min(gh - 1, Math.max(0, fv - R - 1 + a));
        for (let b = 0; b < n; b++) {
            const jx = Math.min(gw - 1, Math.max(0, fu - R - 1 + b));
            const wgt = wy[a] * wx[b];
            const o3 = (jy * gw + jx) * 3;
            out[0] += wgt * c[o3];
            out[1] += wgt * c[o3 + 1];
            out[2] += wgt * c[o3 + 2];
        }
    }
    const norm = sx * sy;
    out[0] /= norm;
    out[1] /= norm;
    out[2] /= norm;
}

/** Per-pixel blend weights for one axis of the blurred grid (cell j spans [j, j+1] in cell units). */
function axisTable(len: number, cell: number, ncell: number, sigma: number, R: number) {
    const n = 2 * R + 3;
    const idx = new Int32Array(len * n),
        wt = new Float64Array(len * n);
    for (let p = 0; p < len; p++) {
        const u = (p + 0.5) / cell;
        const f = Math.floor(u);
        let s = 0;
        for (let k = 0; k < n; k++) {
            const j = f - R - 1 + k;
            const wv = Phi((j + 1 - u) / sigma) - Phi((j - u) / sigma);
            wt[p * n + k] = wv;
            s += wv;
            idx[p * n + k] = Math.min(ncell - 1, Math.max(0, j));
        }
        for (let k = 0; k < n; k++) wt[p * n + k] /= s;
    }
    return { idx, wt, n };
}

/** Render the blurred grid at every pixel of the bbox (sRGB 0..1, bw*bh*3). Separable, so it stays fast. */
function renderMesh(
    c: Float64Array,
    gw: number,
    gh: number,
    cw: number,
    ch: number,
    bw: number,
    bh: number,
    sigma: number,
    R: number
): Float32Array {
    const ax = axisTable(bw, cw, gw, sigma, R),
        ay = axisTable(bh, ch, gh, sigma, R);
    const n = ax.n;
    const T = new Float32Array(gh * bw * 3);
    for (let jy = 0; jy < gh; jy++)
        for (let x = 0; x < bw; x++) {
            let r = 0,
                g = 0,
                b = 0;
            for (let k = 0; k < n; k++) {
                const wv = ax.wt[x * n + k],
                    q = (jy * gw + ax.idx[x * n + k]) * 3;
                r += wv * c[q];
                g += wv * c[q + 1];
                b += wv * c[q + 2];
            }
            const o3 = (jy * bw + x) * 3;
            T[o3] = r;
            T[o3 + 1] = g;
            T[o3 + 2] = b;
        }
    const out = new Float32Array(bw * bh * 3);
    for (let y = 0; y < bh; y++)
        for (let x = 0; x < bw; x++) {
            let r = 0,
                g = 0,
                b = 0;
            for (let k = 0; k < n; k++) {
                const wv = ay.wt[y * n + k],
                    q = (ay.idx[y * n + k] * bw + x) * 3;
                r += wv * T[q];
                g += wv * T[q + 1];
                b += wv * T[q + 2];
            }
            const o3 = (y * bw + x) * 3;
            out[o3] = r;
            out[o3 + 1] = g;
            out[o3 + 2] = b;
        }
    return out;
}

/**
 * Returns the SVG markup for the region's mesh and, when needErr is set, errAt(i): the OKLab distance
 * between the image and what the blurred mesh paints at pixel i. processRegion feeds that to the
 * patch / split refinement, so hard edges the smooth mesh cannot follow get their own shapes.
 */
function meshLayers(
    px: Int32Array,
    fit: { rmse: number },
    clipD: string,
    m: Uint8Array,
    bx: number,
    by: number,
    W: number,
    ctx: RenderContext,
    needErr = false
): { markup: string; errAt: ((i: number) => number) | null } {
    const { o, w, lab, fmt } = ctx;

    // Interior pixels only: boundary pixels are anti-aliased mixes of neighbouring regions.
    let src: ArrayLike<number> = px;
    {
        const inner: number[] = [];
        for (let j = 0; j < px.length; j++) {
            const i = px[j];
            const k = (((i / w) | 0) - by) * W + ((i % w) - bx);
            if (m[k - 1] && m[k + 1] && m[k - W] && m[k + W]) inner.push(i);
        }
        if (inner.length >= 24) src = inner;
    }
    const stride = Math.max(1, Math.ceil(src.length / 200000));
    const n = Math.ceil(src.length / stride);
    const us = new Float32Array(n),
        vs = new Float32Array(n),
        L = new Float32Array(n * 3);
    let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
    for (let j = 0; j < n; j++) {
        const i = src[j * stride];
        us[j] = (i % w) + 0.5;
        vs[j] = ((i / w) | 0) + 0.5;
        L[3 * j] = lab[3 * i];
        L[3 * j + 1] = lab[3 * i + 1];
        L[3 * j + 2] = lab[3 * i + 2];
        if (us[j] < x0) x0 = us[j];
        if (us[j] > x1) x1 = us[j];
        if (vs[j] < y0) y0 = vs[j];
        if (vs[j] > y1) y1 = vs[j];
    }
    const X0 = Math.floor(x0),
        Y0 = Math.floor(y0);
    const bw = Math.max(1, Math.ceil(x1) - X0),
        bh = Math.max(1, Math.ceil(y1) - Y0);
    const long = Math.max(bw, bh);
    const sigma = o.meshBlur;
    const { ker, R } = gaussKernel(sigma);

    const fitGrid = (cells: number) => {
        const gw = Math.max(1, Math.round((bw / long) * cells));
        const gh = Math.max(1, Math.round((bh / long) * cells));
        const cw = bw / gw,
            ch = bh / gh;

        // 1. Mean colour per cell.
        const cnt = new Float64Array(gw * gh);
        const acc = new Float64Array(gw * gh * 3);
        for (let j = 0; j < n; j++) {
            const gx = Math.min(gw - 1, Math.floor((us[j] - X0) / cw));
            const gy = Math.min(gh - 1, Math.floor((vs[j] - Y0) / ch));
            const g = gy * gw + gx;
            cnt[g]++;
            for (let c = 0; c < 3; c++) acc[3 * g + c] += L[3 * j + c];
        }
        const t = new Float64Array(gw * gh * 3); // target colours, sRGB 0..1 (what the blur filter sees)
        const have = new Uint8Array(gw * gh);
        let missing = 0;
        for (let g = 0; g < gw * gh; g++) {
            if (cnt[g] >= 1) {
                have[g] = 1;
                const rgb = oklabToRgb01(acc[3 * g] / cnt[g], acc[3 * g + 1] / cnt[g], acc[3 * g + 2] / cnt[g]);
                t[3 * g] = rgb[0];
                t[3 * g + 1] = rgb[1];
                t[3 * g + 2] = rgb[2];
            } else missing++;
        }

        // 2. Cells outside the region (curved outlines, holes): diffuse colour in from neighbours
        //    so the blur never pulls in black / transparent.
        while (missing > 0) {
            const idx: number[] = [],
                val: number[] = [];
            for (let gy = 0; gy < gh; gy++)
                for (let gx = 0; gx < gw; gx++) {
                    const g = gy * gw + gx;
                    if (have[g]) continue;
                    let k = 0,
                        r = 0,
                        gg = 0,
                        b = 0;
                    for (const [dx, dy] of [
                        [-1, 0],
                        [1, 0],
                        [0, -1],
                        [0, 1],
                    ]) {
                        const xx = gx + dx,
                            yy = gy + dy;
                        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
                        const q = yy * gw + xx;
                        if (!have[q]) continue;
                        k++;
                        r += t[3 * q];
                        gg += t[3 * q + 1];
                        b += t[3 * q + 2];
                    }
                    if (k) {
                        idx.push(g);
                        val.push(r / k, gg / k, b / k);
                    }
                }
            if (!idx.length) break;
            idx.forEach((g, q) => {
                have[g] = 1;
                t[3 * g] = val[3 * q];
                t[3 * g + 1] = val[3 * q + 1];
                t[3 * g + 2] = val[3 * q + 2];
            });
            missing -= idx.length;
        }

        // 3. Deconvolve: find grid colours whose BLURRED version equals the targets.
        const c = Float64Array.from(t);
        for (let it = 0; it < 10; it++) {
            const b = blurGrid(c, gw, gh, ker, R);
            for (let i = 0; i < c.length; i++) c[i] = Math.min(1, Math.max(0, c[i] + (t[i] - b[i])));
        }

        // 4. Pixel-level error of the actual blurred field (not just at cell centres).
        const sp = Math.max(1, Math.floor(n / 6000));
        let se = 0,
            k = 0;
        const f = [0, 0, 0];
        for (let j = 0; j < n; j += sp) {
            fieldAt(c, gw, gh, (us[j] - X0) / cw, (vs[j] - Y0) / ch, sigma, R, f);
            const tg = oklabToRgb01(L[3 * j], L[3 * j + 1], L[3 * j + 2]);
            for (let q = 0; q < 3; q++) {
                const d = f[q] - tg[q];
                se += d * d;
                k++;
            }
        }
        return { gw, gh, cw, ch, c, err: Math.sqrt(se / Math.max(1, k)) };
    };

    // Coarse -> fine until the blurred grid is close enough to the image.
    const cap = Math.min(o.meshCells, Math.max(2, Math.floor(long / 3)));
    const levels = [3, 4, 6, 8, 12, 16, 24, 32, 48, 64].filter((v) => v < cap);
    levels.push(cap);
    let g = fitGrid(levels[0]);
    for (let q = 1; q < levels.length && g.err > o.meshTol; q++) g = fitGrid(levels[q]);

    // Emit: rectangles (padded by replicating edge cells) -> blur -> clip to the region.
    const { gw, gh, cw, ch, c } = g;
    const P = R + 1;
    const fid = "m" + ctx.gradCount++,
        cid = "c" + ctx.gradCount++;
    const fx = X0 - P * cw,
        fy = Y0 - P * ch,
        fW = (gw + 2 * P) * cw,
        fH = (gh + 2 * P) * ch;
    ctx.defs.push(
        `<filter id="${fid}" filterUnits="userSpaceOnUse" x="${fmt(fx)}" y="${fmt(fy)}" width="${fmt(fW)}" height="${fmt(fH)}" color-interpolation-filters="sRGB">` +
            `<feGaussianBlur stdDeviation="${fmt(sigma * cw)} ${fmt(sigma * ch)}"/></filter>`,
        `<clipPath id="${cid}"><path d="${clipD}" clip-rule="evenodd"/></clipPath>`
    );
    let rects = "";
    for (let gy = -P; gy < gh + P; gy++) {
        const sy = Math.min(gh - 1, Math.max(0, gy));
        let runStart = -P,
            runCol = "";
        for (let gx = -P; gx <= gw + P; gx++) {
            let col = "";
            if (gx < gw + P) {
                const sx = Math.min(gw - 1, Math.max(0, gx));
                const q = (sy * gw + sx) * 3;
                col = hex([c[q], c[q + 1], c[q + 2]]);
            }
            if (col !== runCol) {
                // merge horizontal runs of identical colour; +0.5px overlap hides AA seams
                if (runCol)
                    rects += `<rect x="${fmt(X0 + runStart * cw)}" y="${fmt(Y0 + gy * ch)}" width="${fmt((gx - runStart) * cw + 0.5)}" height="${fmt(ch + 0.5)}" fill="${runCol}"/>`;
                runStart = gx;
                runCol = col;
            }
        }
    }
    const markup = `<g clip-path="url(#${cid})"><g filter="url(#${fid})">${rects}</g></g>`;
    if (!needErr) return { markup, errAt: null };

    const rend = renderMesh(c, gw, gh, cw, ch, bw, bh, sigma, R);
    const errAt = (i: number): number => {
        const x = Math.min(bw - 1, Math.max(0, (i % w) - X0)),
            y = Math.min(bh - 1, Math.max(0, ((i / w) | 0) - Y0));
        const q = (y * bw + x) * 3;
        const l = rgb01ToOklab(rend[q], rend[q + 1], rend[q + 2]);
        return Math.hypot(lab[3 * i] - l[0], lab[3 * i + 1] - l[1], lab[3 * i + 2] - l[2]);
    };
    return { markup, errAt };
}

/* ------------------------------------------------------------------ split */

function splitRegion(px: Int32Array, ctx: RenderContext): Int32Array[] {
    const { o, w, lab } = ctx;
    const n = px.length;
    let x0 = Infinity,
        y0 = Infinity,
        x1 = -1,
        y1 = -1;
    for (let j = 0; j < n; j++) {
        const x = px[j] % w,
            y = (px[j] / w) | 0;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    const bw = x1 - x0 + 1,
        bh = y1 - y0 + 1;
    const posW = 0.06 / Math.max(bw, bh);
    const F = new Float32Array(n * 5);
    let lo = 0,
        hi = 0;
    for (let j = 0; j < n; j++) {
        const i = px[j];
        F[5 * j] = lab[3 * i];
        F[5 * j + 1] = lab[3 * i + 1];
        F[5 * j + 2] = lab[3 * i + 2];
        F[5 * j + 3] = (i % w) * posW;
        F[5 * j + 4] = ((i / w) | 0) * posW;
        if (lab[3 * i] < lab[3 * px[lo]]) lo = j;
        if (lab[3 * i] > lab[3 * px[hi]]) hi = j;
    }
    const cen = new Float64Array(10);
    for (let c = 0; c < 5; c++) {
        cen[c] = F[5 * lo + c];
        cen[5 + c] = F[5 * hi + c];
    }
    const asg = new Uint8Array(n);
    for (let it = 0; it < 6; it++) {
        const sum = new Float64Array(10),
            cnt = [0, 0];
        for (let j = 0; j < n; j++) {
            let d0 = 0,
                d1 = 0;
            for (let c = 0; c < 5; c++) {
                d0 += (F[5 * j + c] - cen[c]) ** 2;
                d1 += (F[5 * j + c] - cen[5 + c]) ** 2;
            }
            const a = d1 < d0 ? 1 : 0;
            asg[j] = a;
            cnt[a]++;
            for (let c = 0; c < 5; c++) sum[5 * a + c] += F[5 * j + c];
        }
        if (!cnt[0] || !cnt[1]) return [];
        for (let a = 0; a < 2; a++) for (let c = 0; c < 5; c++) cen[5 * a + c] = sum[5 * a + c] / cnt[a];
    }

    const cl = new Uint8Array(bw * bh);
    for (let j = 0; j < n; j++) cl[(((px[j] / w) | 0) - y0) * bw + ((px[j] % w) - x0)] = 1 + asg[j];
    const vis = new Uint8Array(bw * bh);
    const groups: Int32Array[] = [];
    const stack: number[] = [];
    for (let j = 0; j < n; j++) {
        const s = (((px[j] / w) | 0) - y0) * bw + ((px[j] % w) - x0);
        if (vis[s]) continue;
        const val = cl[s],
            comp: number[] = [];
        stack.push(s);
        vis[s] = 1;
        while (stack.length) {
            const p = stack.pop()!;
            const x = p % bw,
                y = (p / bw) | 0;
            comp.push((y + y0) * w + (x + x0));
            if (x > 0 && !vis[p - 1] && cl[p - 1] === val) {
                vis[p - 1] = 1;
                stack.push(p - 1);
            }
            if (x < bw - 1 && !vis[p + 1] && cl[p + 1] === val) {
                vis[p + 1] = 1;
                stack.push(p + 1);
            }
            if (y > 0 && !vis[p - bw] && cl[p - bw] === val) {
                vis[p - bw] = 1;
                stack.push(p - bw);
            }
            if (y < bh - 1 && !vis[p + bw] && cl[p + bw] === val) {
                vis[p + bw] = 1;
                stack.push(p + bw);
            }
        }
        if (comp.length >= o.minRegionArea) groups.push(Int32Array.from(comp));
    }
    groups.sort((a, b) => b.length - a.length);
    return groups.length >= 2 ? groups : [];
}

/* ----------------------------------------------------------------- region */

function inkPath(top: number, bx: number, by: number, W: number, H: number, ctx: RenderContext): string {
    const { o, w, h, soft, inkLabels, fmt } = ctx;
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
    return fieldToPath(g, W, H, bx, by, o, fmt);
}

function processRegion(
    px: Int32Array,
    depth: number,
    top: number,
    isInk: boolean,
    out: PathItem[],
    ctx: RenderContext
): void {
    const { o, w, h, labels, ink, fmt, rank } = ctx;
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
    const P = o.expand + 4;
    const bx = x0 - P,
        by = y0 - P;
    const W = x1 - x0 + 1 + 2 * P,
        H = y1 - y0 + 1 + 2 * P;
    const m0 = new Uint8Array(W * H);
    for (let j = 0; j < px.length; j++) m0[(((px[j] / w) | 0) - by) * W + ((px[j] % w) - bx)] = 1;
    let m = m0;

    const fit = analyze(px, m0, bx, by, W, ctx);

    if (isInk) {
        const d = inkPath(top, bx, by, W, H, ctx);
        if (d) out.push({ d, fill: fit.fill });
        return;
    }

    for (let it = 0; it < o.expand; it++) {
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
                const rankTop = rank ? rank[top] : 0;
                const rankLg = rank && lg >= 0 ? rank[lg] : 0;
                if (!(ink[g] || lg === top || (lg >= 0 && rankLg > rankTop))) continue;
                if (m[k - 1] || m[k + 1] || m[k - W] || m[k + W]) nx[k] = 1;
            }
        }
        m = nx;
    }

    // What this region is actually painted with, so refinement measures the error of the real output.
    let errAt = fit.errAt;

    const d = maskToPath(m, W, H, bx, by, w, h, o, fmt);
    if (d) {
        const item: PathItem = { d, fill: fit.fill };
        if (depth > 0 && o.patchFeather > 0) {
            item.feather = o.patchFeather;
            item.box = [bx, by, W, H];
        }
        out.push(item);
        if (px.length >= o.minSplitArea && fit.rmse > o.flatTol) {
            if (o.meshCells > 0) {
                const r = meshLayers(px, fit, d, m0, bx, by, W, ctx, depth < o.maxDepth);
                if (r.markup) item.extra = r.markup;
                if (r.errAt) errAt = r.errAt;
            } else if (o.softBlobs > 0) {
                const extra = softLayers(px, fit, d, m0, bx, by, W, ctx);
                if (extra) item.extra = extra;
            }
        }
    }
    // Soft blobs cannot report their error, so they keep replacing the refinement. The mesh does not.
    if (o.meshCells === 0 && o.softBlobs > 0) return;

    if (depth >= o.maxDepth || px.length < o.minSplitArea) return;

    const E = new Float32Array(W * H);
    let sq = 0,
        cnt = 0;
    for (let j = 0; j < px.length; j++) {
        const i = px[j];
        const k = (((i / w) | 0) - by) * W + ((i % w) - bx);
        if (!(m0[k - 1] && m0[k + 1] && m0[k - W] && m0[k + W])) continue;
        const e = errAt(i);
        E[k] = e;
        sq += e * e;
        cnt++;
    }
    const rmse = cnt ? Math.sqrt(sq / cnt) : 0;

    const seen = new Uint8Array(W * H);
    const patches: Int32Array[] = [];
    const stack: number[] = [];
    for (let j = 0; j < px.length; j++) {
        const i = px[j];
        const s0 = (((i / w) | 0) - by) * W + ((i % w) - bx);
        if (seen[s0] || E[s0] < o.patchCore) continue;
        const comp: number[] = [];
        let seeds = 0;
        stack.push(s0);
        seen[s0] = 1;
        while (stack.length) {
            const p = stack.pop()!;
            if (E[p] >= o.patchCore) seeds++;
            comp.push(p);
            for (const q of [p - 1, p + 1, p - W, p + W])
                if (!seen[q] && E[q] >= o.patchEdge) {
                    seen[q] = 1;
                    stack.push(q);
                }
        }
        if (seeds < o.patchMin) continue;
        const arr = new Int32Array(comp.length);
        for (let c = 0; c < comp.length; c++) {
            const p = comp[c];
            arr[c] = (((p / W) | 0) + by) * w + ((p % W) + bx);
        }
        patches.push(arr);
    }

    const patched = patches.reduce((a, p) => a + p.length, 0);
    if (patches.length && patched < px.length * 0.85) {
        patches.sort((a, b) => b.length - a.length);
        for (const kid of patches) processRegion(kid, depth + 1, top, false, out, ctx);
    } else if (rmse > o.splitTol) {
        const kids = splitRegion(px, ctx);
        for (const kid of kids) processRegion(kid, depth + 1, top, false, out, ctx);
    }
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
        for (let i = 0; i < n; i++) if (r.labels[i] >= 0 && r.sizes[r.labels[i]] < o.minRegionArea) ink[i] = 0;
    }

    const core = new Uint8Array(n);
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
            if (g2 <= o.edgeT * o.edgeT) core[i] = 1;
        }
    const reg = labelComponents(core, w, h, false);
    for (let i = 0; i < n; i++) {
        const l = reg.labels[i];
        if (l >= 0 && reg.sizes[l] < o.minRegionArea) reg.labels[i] = -1;
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
        const nbrs = (p: number): number[] => {
            const x = p % w;
            return [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1];
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
                const p = frontier[k];
                let bl = -1,
                    bd = Infinity;
                for (const r of nbrs(p)) {
                    if (r < 0) continue;
                    const l = reg.labels[r];
                    if (l < 0) continue;
                    const d =
                        (lab[p * 3] - sumL[l * 3]) ** 2 +
                        (lab[p * 3 + 1] - sumL[l * 3 + 1]) ** 2 +
                        (lab[p * 3 + 2] - sumL[l * 3 + 2]) ** 2;
                    if (d < bd) {
                        bd = d;
                        bl = l;
                    }
                }
                pick[k] = bl;
            }
            const next: number[] = [];
            for (let k = 0; k < frontier.length; k++) reg.labels[frontier[k]] = pick[k];
            for (const p of frontier)
                for (const r of nbrs(p))
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
        .filter((r) => r.px.length >= o.minRegionArea)
        .sort((a, b) => b.px.length - a.px.length);

    regionLists.forEach((r, k) => (rank[r.label] = k));

    const inkLists = groupPixels(inkC.labels, inkC.count)
        .map((px, label) => ({ px, label }))
        .filter((r) => r.px.length > 0)
        .sort((a, b) => b.px.length - a.px.length);

    const ctx: RenderContext = {
        o,
        w,
        h,
        lab,
        ink,
        soft,
        inkLabels: inkC.labels,
        labels: reg.labels,
        fmt: makeFmt(o.precision),
        defs: [],
        gradCount: 0,
        rank,
    };

    const items: PathItem[] = [];
    for (const r of regionLists) processRegion(r.px, 0, r.label, false, items, ctx);
    for (const r of inkLists) processRegion(r.px, 0, r.label, true, items, ctx);

    let body = "";
    for (const it of items) {
        const inner = `<path d="${it.d}" fill="${it.fill}" fill-rule="evenodd"/>` + (it.extra ?? "");
        if (it.feather && it.box) {
            const id = "f" + ctx.gradCount++;
            const pad = Math.ceil(it.feather * 3);
            const [bx0, by0, bw0, bh0] = it.box;
            ctx.defs.push(
                `<filter id="${id}" filterUnits="userSpaceOnUse" x="${bx0 - pad}" y="${by0 - pad}" width="${bw0 + 2 * pad}" height="${bh0 + 2 * pad}" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${ctx.fmt(it.feather)}"/></filter>`
            );
            body += `<g filter="url(#${id})">${inner}</g>`;
        } else body += inner;
    }
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${outW}" height="${outH}">`;
    if (ctx.defs.length) svg += "<defs>" + ctx.defs.join("") + "</defs>";
    return svg + body + "</svg>";
}

export default imageDataToSVG;
