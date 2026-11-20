# Xavryn

Turn raster images into clean, compact SVGs with smooth Bézier outlines and fitted linear/radial gradients, instead of posterized color bands or thousands of tiny pixel-squares. Everything runs locally in your browser. Nothing is uploaded.

Source: [github.com/ganemedelabs/xavryn](https://github.com/ganemedelabs/xavryn)

## Features

- **Gradient-aware vectorization**: regions are fitted as flat fills, linear gradients, or radial gradients, with the colour profile reduced to a few stops.
- **OKLab segmentation**: colour differences are measured in a perceptual colour space, so region boundaries land where the colour actually changes.
- **Smooth paths**: subpixel contour tracing (marching squares), corner detection, and cubic Bézier fitting (Schneider's algorithm).
- **Ink handling**: solid dark pixels (outlines, black spots) are traced separately from a soft coverage field so thin strokes keep the right thickness.
- **Recursive refinement**: poorly fitted areas become patches painted on top of their parent region, or the region is split via 2-means clustering.
- **Seamless output**: each region is grown underneath the regions painted after it, so no anti-aliasing seams show.
- **Live controls**: every parameter is a slider with a help tooltip, plus one-click presets and a reset button.
- **Auto-tune (beta)**: an evolutionary search that tunes parameters for you by comparing the rendered SVG against the original.
- **Four preview modes**: Side by Side, Vector SVG, Original, and SVG Markup.
- **Copy or download** the resulting SVG.
- **Responsive, accessible UI**: dark/light theme toggle, keyboard-navigable tabs and dropzone, a skip link, and screen-reader status announcements.
- **Off the main thread**: conversion runs in a Web Worker, so the UI stays responsive.

## Supported input

Raster images: PNG, JPEG, WebP, GIF, BMP, AVIF. SVG input is rejected on purpose. The goal is raster → vector. Pixels with alpha below the cutoff are treated as transparent and left empty.

## Getting started

Prerequisites: Node.js and a package manager (npm, pnpm, or yarn).

```bash
git clone https://github.com/ganemedelabs/xavryn.git
cd xavryn
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

To make a production build:

```bash
npm run build
npm start
```

## Usage

1. Drop an image on the dropzone, or click **Choose Image**.
2. The image is vectorized automatically. Compare the result in any of the preview modes.
3. Pick a **preset** or adjust individual **parameters** (hover or click the `?` next to a slider for an explanation). Click **Re-render SVG** to apply changes.
4. Optionally click **Auto-tune parameters** and let the optimizer search for a better configuration. You can cancel at any time.
5. **Copy SVG** or **Download SVG** from the header.

The sidebar also shows output dimensions, SVG size in KB, and render time.

## How it works

The pipeline lives in `lib/img-to-svg.ts`:

1. **Colour conversion**: the image is converted to OKLab. "Ink" is solid dark pixels (below `inkL`). Dark-but-not-black areas, such as dark hair, are regions, not ink.
2. **Edges and regions**: pixels whose colour changes abruptly (`edgeT`) are hard edges. Flat areas between edges and ink become regions. Edge pixels join the neighbouring region whose colour matches best.
3. **Fitting**: each region is fitted as flat, linear gradient, or radial gradient (radial centres are found with Nelder–Mead), and the colour profile is reduced to a few stops.
4. **Refinement**: clearly mis-fitted areas are refit as their own patches, painted on top, recursively up to `maxDepth`.
5. **Tracing**: regions are traced at subpixel precision, corners are detected, and cubic Béziers are fitted.
6. **Painting order**: the largest region is painted first. Each region is grown under whatever is painted after it, and under the ink.

### Auto-tune

`lib/auto-tune.ts` runs a simple evolutionary search over 14 tunable parameters (several on a log scale):

- It picks up to three representative 512 px crops (the most detailed tiles plus a median one), so large images tune quickly.
- Each candidate is rendered in a worker pool, rasterized, and scored against the original, combining image error with a small penalty on SVG size.
- Each generation produces 8 mutated offspring from the current best. The step size shrinks when no improvement is found. The default budget is 64 evaluations.
- Crop-sized length and area parameters are rescaled back to the full working size at the end.

## Parameters

All parameters are defined in `OPTIONS` (`lib/img-to-svg.ts`) with a default, range, and description. They are used for both the UI and option validation.

| Option          | Default | Range     | What it does                                                     |
| --------------- | ------- | --------- | ---------------------------------------------------------------- |
| `maxSize`       | 1600    | 64–8192   | Longest side of the working image; larger inputs are downscaled  |
| `alphaCutoff`   | 128     | 1–255     | Alpha below this is treated as transparent                       |
| `inkL`          | 0.2     | 0–0.6     | OKLab lightness below which a pixel counts as ink                |
| `minRegionArea` | 12      | 1–500     | Smallest region or ink component kept (px)                       |
| `expand`        | 2       | 0–8       | Overlap, in px, grown under later-painted regions                |
| `flatTol`       | 0.012   | 0–0.1     | RMS error below which a region is a flat fill                    |
| `splitTol`      | 0.035   | 0–0.2     | RMS error above which a region is split                          |
| `maxDepth`      | 3       | 0–6       | Maximum recursive refinements                                    |
| `minSplitArea`  | 150     | 1–10000   | Regions smaller than this are never refined                      |
| `bins`          | 32      | 4–128     | Bins in the 1D colour profile                                    |
| `stopTol`       | 0.008   | 0–0.1     | Max error allowed when dropping gradient stops                   |
| `maxStops`      | 6       | 2–16      | Maximum stops per gradient                                       |
| `curveTol`      | 0.8     | 0.1–5     | Bézier fitting tolerance (px)                                    |
| `cornerAngle`   | 50      | 10–170    | Turning angle (°) above which a point is a sharp corner          |
| `cornerWindow`  | 4       | 2–12      | Points on each side used to measure turning angle                |
| `minRingArea`   | 3       | 0–100     | Contours smaller than this (px²) are dropped                     |
| `precision`     | 2       | 0–6       | Decimals written in path coordinates                             |
| `patchCore`     | 0.08    | 0.01–0.5  | Error at which a pixel seeds a patch                             |
| `patchEdge`     | 0.045   | 0.005–0.5 | Error below which a patch stops growing (keep below `patchCore`) |
| `patchMin`      | 12      | 1–500     | Minimum seed pixels needed to create a patch                     |
| `edgeT`         | 0.02    | 0.002–0.2 | OKLab change per pixel above which a pixel is a hard edge        |

### Tips

- **Too many tiny shapes or noisy output**: raise `minRegionArea` and `edgeT`, or lower `maxDepth`.
- **Smaller files**: raise `flatTol`, `stopTol`, and `curveTol`, and lower `precision` and `maxStops`.
- **Missing highlights or subtle shading**: lower `edgeT`, `patchCore`, and `flatTol`, or raise `maxDepth`.
- **Dark areas wrongly turned into solid black**: lower `inkL`.
- **Hairline gaps between shapes**: raise `expand`.

## Using the converter as a library

The converter has no UI dependencies, so you can use it directly:

```ts
import { imageDataToSVG, OPTIONS, resolveOptions } from "@/lib/img-to-svg";

const svg = imageDataToSVG(imageData, { maxSize: 1200, curveTol: 1.2 });
```

`imageData` is anything shaped like `ImageData` (`{ data, width, height }`). Options are clamped to their valid ranges, and missing or invalid values fall back to defaults (`resolveOptions`).

## Limitations

- Best suited to illustrations, logos, icons, and flat/gradient-shaded artwork. Photographs and heavily textured images will produce large, fragmented SVGs.
- Very large images are downscaled to `maxSize` before analysis (the SVG `width`/`height` keep the original size).
- Auto-tune is beta. Results vary by image and the search is stochastic.

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/ganemedelabs/xavryn).

## License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.
