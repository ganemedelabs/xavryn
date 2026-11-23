/// <reference lib="webworker" />
import { imageDataToSVG } from "../lib/img-to-svg";

self.onmessage = (e: MessageEvent) => {
    const { id, imageData, options } = e.data;
    try {
        const start = performance.now();
        const svg = imageDataToSVG(imageData, options);
        const durationMs = Math.round(performance.now() - start);
        self.postMessage({ id, svg, durationMs });
    } catch (error: unknown) {
        self.postMessage({
            id,
            error: (error as Error).message || "Conversion failed",
            cause: error,
        });
    }
};
