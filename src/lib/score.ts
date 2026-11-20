/** Mean OKLab distance, with alpha composited over mid-gray so transparency mismatches count. */
export function oklabError(a: ImageData, b: ImageData): number {
    const A = a.data,
        B = b.data;
    let sum = 0;
    const n = a.width * a.height;
    for (let i = 0; i < A.length; i += 4) {
        const aa = A[i + 3] / 255,
            ba = B[i + 3] / 255;
        const pa = srgbToOklab(
            A[i] * aa + 128 * (1 - aa),
            A[i + 1] * aa + 128 * (1 - aa),
            A[i + 2] * aa + 128 * (1 - aa)
        );
        const pb = srgbToOklab(
            B[i] * ba + 128 * (1 - ba),
            B[i + 1] * ba + 128 * (1 - ba),
            B[i + 2] * ba + 128 * (1 - ba)
        );
        sum += Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    }
    return sum / n;
}

function srgbToOklab(r: number, g: number, b: number): [number, number, number] {
    const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
}

export async function rasterizeSvg(svg: string, w: number, h: number): Promise<ImageData> {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = new OffscreenCanvas(w, h);
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
    } finally {
        URL.revokeObjectURL(url);
    }
}

export interface Prepared {
    w: number;
    h: number;
    lab: Float32Array;
}

function toLab(img: ImageData): Float32Array {
    const d = img.data;
    const out = new Float32Array((d.length / 4) * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
        const a = d[i + 3] / 255;
        const bg = 128 * (1 - a); // composite over mid-gray
        const lab = srgbToOklab(d[i] * a + bg, d[i + 1] * a + bg, d[i + 2] * a + bg);
        out[j] = lab[0];
        out[j + 1] = lab[1];
        out[j + 2] = lab[2];
    }
    return out;
}

export const prepare = (img: ImageData): Prepared => ({ w: img.width, h: img.height, lab: toLab(img) });

/** RMS OKLab error + gradient error + worst-blocks error (penalizes localized flaws). */
export function compare(ref: Prepared, img: ImageData, gradWeight = 2, tailWeight = 1): number {
    const { w, h, lab: r } = ref;
    const t = toLab(img);
    const B = 16;
    const bw = Math.ceil(w / B);
    const bh = Math.ceil(h / B);
    const blockErr = new Float64Array(bw * bh);
    const blockCnt = new Uint32Array(bw * bh);
    let se = 0,
        ge = 0;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 3;
            const dl = r[i] - t[i],
                da = r[i + 1] - t[i + 1],
                db = r[i + 2] - t[i + 2];
            const e = dl * dl + da * da + db * db;
            se += e;
            const bi = Math.floor(y / B) * bw + Math.floor(x / B);
            blockErr[bi] += e;
            blockCnt[bi]++;
            if (x < w - 1 && y < h - 1) {
                const ix = i + 3,
                    iy = i + w * 3;
                for (let c = 0; c < 3; c++) {
                    const gx = r[ix + c] - r[i + c] - (t[ix + c] - t[i + c]);
                    const gy = r[iy + c] - r[i + c] - (t[iy + c] - t[i + c]);
                    ge += gx * gx + gy * gy;
                }
            }
        }
    }

    const n = w * h;
    const means = Array.from(blockErr, (v, i) => v / blockCnt[i]).sort((a, b) => b - a);
    const k = Math.max(1, Math.ceil(means.length * 0.05));
    let tail = 0;
    for (let i = 0; i < k; i++) tail += means[i];
    tail /= k;

    return Math.sqrt(se / n) + gradWeight * Math.sqrt(ge / n) + tailWeight * Math.sqrt(tail);
}

/** Quality first: only penalizes files larger than the baseline. sizeWeight = 0 ignores size entirely. */
export const score = (err: number, sizeKb: number, baseKb: number, sizeWeight = 0.05) =>
    err * (1 + sizeWeight * Math.max(0, Math.log2(sizeKb / baseKb)));
