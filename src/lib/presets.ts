import { OPTIONS } from "./img-to-svg";

type OptionKey = keyof typeof OPTIONS;

export interface Preset {
    id: string;
    label: string;
    description: string;
    /** Only the values that differ from the defaults. */
    options: Partial<Record<OptionKey, number>>;
}

export const PRESETS: Preset[] = [
    {
        id: "default",
        label: "Default",
        description: "Balanced settings for most images.",
        options: {},
    },
    {
        id: "logo",
        label: "Logo / Flat",
        description: "Flat colors, few gradients, clean corners and small files.",
        options: {
            inkL: 0.25,
            minRegionArea: 20,
            edgeT: 0.04,
            flatTol: 0.03,
            splitTol: 0.08,
            maxDepth: 1,
            stopTol: 0.02,
            maxStops: 3,
            curveTol: 1.2,
            cornerAngle: 40,
            patchCore: 0.15,
            patchEdge: 0.08,
        },
    },
    {
        id: "illustration",
        label: "Illustration",
        description: "Cartoons and digital art: outlines, smooth shading, moderate detail.",
        options: {
            inkL: 0.22,
            edgeT: 0.03,
            flatTol: 0.015,
            maxDepth: 3,
            curveTol: 0.8,
            cornerAngle: 45,
            maxStops: 5,
        },
    },
    {
        id: "photo",
        label: "Photo",
        description: "Smooth tonal changes: more gradient stops and refinement, less ink.",
        options: {
            inkL: 0.08,
            minRegionArea: 16,
            edgeT: 0.03,
            flatTol: 0.006,
            splitTol: 0.02,
            maxDepth: 5,
            stopTol: 0.004,
            maxStops: 8,
            patchCore: 0.05,
            patchEdge: 0.03,
            patchMin: 8,
            curveTol: 1,
            cornerAngle: 70,
        },
    },
    {
        id: "lineart",
        label: "Line art",
        description: "Sketches and drawings: thin strokes are kept, fills stay flat.",
        options: {
            inkL: 0.35,
            minRegionArea: 6,
            flatTol: 0.03,
            maxDepth: 1,
            curveTol: 0.5,
            cornerAngle: 45,
            minRingArea: 1,
        },
    },
    {
        id: "detail",
        label: "High detail",
        description: "Keeps as much as possible. Larger file and slower.",
        options: {
            minRegionArea: 6,
            edgeT: 0.012,
            flatTol: 0.006,
            splitTol: 0.02,
            maxDepth: 5,
            minSplitArea: 60,
            bins: 48,
            stopTol: 0.004,
            maxStops: 10,
            curveTol: 0.4,
            patchCore: 0.05,
            patchEdge: 0.03,
            patchMin: 6,
        },
    },
    {
        id: "small",
        label: "Small file",
        description: "Aggressive simplification for the smallest SVG.",
        options: {
            minRegionArea: 40,
            edgeT: 0.05,
            flatTol: 0.04,
            splitTol: 0.1,
            maxDepth: 1,
            minSplitArea: 400,
            bins: 16,
            stopTol: 0.03,
            maxStops: 3,
            curveTol: 2,
            minRingArea: 12,
            precision: 1,
            patchMin: 40,
        },
    },
];

/** Full option set for a preset. Resolution and transparency settings are kept from `current`. */
export function resolvePreset(preset: Preset, current: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of Object.keys(OPTIONS) as OptionKey[]) {
        const spec = OPTIONS[key];
        let v = preset.options[key] ?? spec.default;
        v = Math.min(spec.max, Math.max(spec.min, v));
        out[key] = spec.integer ? Math.round(v) : v;
    }
    out.maxSize = current.maxSize;
    out.alphaCutoff = current.alphaCutoff;
    return out;
}
