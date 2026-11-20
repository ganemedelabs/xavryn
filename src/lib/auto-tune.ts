import { OPTIONS } from "./img-to-svg";
import { compare, prepare, rasterizeSvg, score } from "./score";
import { WorkerPool } from "./worker-pool";

type Opts = Record<string, number>;
type Vec = Record<string, number>;
type Spec = { min: number; max: number; integer?: boolean };
const spec = (k: string) => (OPTIONS as unknown as Record<string, Spec>)[k];

const TUNABLE = [
    "inkL",
    "minRegionArea",
    "flatTol",
    "splitTol",
    "maxDepth",
    "stopTol",
    "maxStops",
    "curveTol",
    "cornerAngle",
    "patchCore",
    "patchEdge",
    "edgeT",
    "expand",
    "bins",
] as const;

const LOG = new Set(["minRegionArea", "edgeT", "patchCore", "patchEdge", "curveTol", "stopTol", "flatTol", "splitTol"]);

const eps = (s: Spec) => 0.02 * (s.max - s.min);
const toUnit = (k: string, v: number) => {
    const s = spec(k),
        range = s.max - s.min;
    if (!LOG.has(k)) return (v - s.min) / range;
    const e = eps(s);
    return (Math.log(v - s.min + e) - Math.log(e)) / (Math.log(range + e) - Math.log(e));
};
const fromUnit = (k: string, t: number) => {
    const s = spec(k),
        range = s.max - s.min;
    let v: number;
    if (LOG.has(k)) {
        const e = eps(s);
        v = s.min + Math.exp(Math.log(e) + t * (Math.log(range + e) - Math.log(e))) - e;
    } else v = s.min + t * range;
    return clampSpec(k, v);
};
function clampSpec(k: string, v: number) {
    const s = spec(k);
    v = Math.min(s.max, Math.max(s.min, v));
    return s.integer ? Math.round(v) : v;
}

const LEN = ["curveTol", "expand", "cornerWindow"];
const AREA = ["minRegionArea", "minSplitArea", "minRingArea", "patchMin"];

/** k = newLongestSide / oldLongestSide. Lengths scale by k, areas by k². */
export function scaleOpts(o: Opts, k: number): Opts {
    const out = { ...o };
    for (const key of LEN) out[key] = clampSpec(key, o[key] * k);
    for (const key of AREA) out[key] = clampSpec(key, o[key] * k * k);
    return out;
}

export async function loadImageData(file: File, maxSide?: number): Promise<ImageData> {
    const bmp = await createImageBitmap(file);
    const scale = maxSide ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height)) : 1;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return ctx.getImageData(0, 0, w, h);
}

const gauss = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function build(base: Opts, vec: Vec): Opts {
    const o = { ...base };
    for (const k of TUNABLE) o[k] = fromUnit(k, vec[k]);
    if (o.patchEdge >= o.patchCore) o.patchEdge = Math.max(spec("patchEdge").min, o.patchCore * 0.6);
    return o;
}

function cropImageData(src: ImageData, x0: number, y0: number, w: number, h: number): ImageData {
    const out = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
        const s = ((y0 + y) * src.width + x0) * 4;
        out.data.set(src.data.subarray(s, s + w * 4), y * w * 4);
    }
    return out;
}

export function pickCrops(img: ImageData, size = 512): ImageData[] {
    const { width: W, height: H, data } = img;
    if (Math.max(W, H) <= size * 1.25) return [img];

    const cw = Math.min(size, W);
    const ch = Math.min(size, H);
    const lum = (i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

    const tiles: { x: number; y: number; density: number }[] = [];
    for (let y = 0; y + ch <= H; y += Math.max(1, ch >> 1)) {
        for (let x = 0; x + cw <= W; x += Math.max(1, cw >> 1)) {
            let edge = 0;
            let opaque = 0;
            let n = 0;
            for (let yy = y; yy < y + ch - 1; yy += 2) {
                for (let xx = x; xx < x + cw - 1; xx += 2) {
                    const i = (yy * W + xx) * 4;
                    if (data[i + 3] >= 128) opaque++;
                    edge += Math.abs(lum(i) - lum(i + 4)) + Math.abs(lum(i) - lum(i + W * 4));
                    n++;
                }
            }
            if (opaque / n < 0.2) continue;
            tiles.push({ x, y, density: edge / n });
        }
    }
    if (!tiles.length) return [img];

    const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        Math.abs(a.x - b.x) < cw && Math.abs(a.y - b.y) < ch;

    const sorted = [...tiles].sort((a, b) => b.density - a.density);
    const chosen: typeof tiles = [];
    for (const t of sorted) {
        if (chosen.length >= 2) break;
        if (!chosen.some((c) => overlaps(c, t))) chosen.push(t);
    }
    const mid = sorted[sorted.length >> 1];
    if (mid && !chosen.some((c) => overlaps(c, mid))) chosen.push(mid);

    return chosen.map((t) => cropImageData(img, t.x, t.y, cw, ch));
}

interface Result {
    vec: Vec;
    opts: Opts;
    err: number;
    kb: number;
    score: number;
}

export async function autoTune(
    sources: ImageData[],
    base: Opts,
    onProgress?: (cur: Result, done: number, total: number) => void,
    {
        budget = 64,
        offspring = 8,
        sizeWeight = 0.05,
        signal,
    }: {
        budget?: number;
        offspring?: number;
        sizeWeight?: number;
        signal?: AbortSignal;
    } = {}
) {
    const pool = new WorkerPool();
    const refs = sources.map(prepare);
    let baseKb = 1;
    let failed = 0;

    const evaluate = async (vec: Vec): Promise<Result | null> => {
        if (signal?.aborted) return null;
        const opts = build(base, vec);
        try {
            const runs = await Promise.all(
                sources.map(async (src, i) => {
                    const { svg } = await pool.run(src, opts);
                    const raster = await rasterizeSvg(svg, src.width, src.height);
                    return { err: compare(refs[i], raster), kb: svg.length / 1024 };
                })
            );
            const err = runs.reduce((a, r) => a + r.err, 0) / runs.length;
            const kb = runs.reduce((a, r) => a + r.kb, 0);
            return { vec, opts, err, kb, score: score(err, kb, baseKb, sizeWeight) };
        } catch (e) {
            if (!signal?.aborted) {
                failed++;
                console.warn("[auto-tune] candidate failed:", e);
            }
            return null;
        }
    };

    try {
        const baseVec: Vec = Object.fromEntries(TUNABLE.map((k) => [k, toUnit(k, base[k])]));
        const baseline = await evaluate(baseVec);
        if (!baseline) throw new Error("Baseline render/rasterize failed — check console for the cause.");
        baseKb = baseline.kb;
        baseline.score = baseline.err;

        let cur = baseline;
        let sigma = 0.3;
        let done = 1;
        console.info(
            `[auto-tune] ${sources.length} crop(s), baseline err=${baseline.err.toFixed(4)} size=${baseline.kb.toFixed(1)}KB`
        );

        while (done < budget && !signal?.aborted) {
            const batch = Array.from({ length: offspring }, () => {
                const vec = { ...cur.vec };
                const keys = [...TUNABLE].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
                for (const k of keys) vec[k] = clamp01(vec[k] + gauss() * sigma);
                return vec;
            });
            const results = (await Promise.all(batch.map(evaluate))).filter((r): r is Result => !!r);
            done += offspring;
            const top = results.sort((a, b) => a.score - b.score)[0];
            if (top && top.score < cur.score) cur = top;
            else sigma = Math.max(0.04, sigma * 0.7);
            onProgress?.(cur, Math.min(done, budget), budget);
        }

        console.info(`[auto-tune] best err=${cur.err.toFixed(4)} size=${cur.kb.toFixed(1)}KB, failed=${failed}`);
        return { ...cur, baselineErr: baseline.err };
    } finally {
        pool.terminate();
    }
}
