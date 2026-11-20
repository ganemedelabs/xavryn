import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
    return {
        name: "Xavryn",
        short_name: "Xavryn",
        description:
            "Turn raster images into clean, compact SVGs with smooth Bézier curves and fitted gradients locally in the browser.",
        start_url: "/",
        display: "standalone",
        background_color: "#f6f6f9",
        theme_color: "#f6f6f9",
        icons: [
            {
                src: "/images/icon-192x192.png",
                sizes: "192x192",
                type: "image/png",
                purpose: "maskable",
            },
            {
                src: "/images/icon-512x512.png",
                sizes: "512x512",
                type: "image/png",
                purpose: "maskable",
            },
        ],
    };
}
