import { ThemeProvider } from "@/components/theme-provider";
import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const mono = JetBrains_Mono({
    variable: "--mono",
    subsets: ["latin"],
    fallback: [
        "ui-monospace",
        "SFMono-Regular",
        "Menlo",
        "Monaco",
        "Consolas",
        "Liberation Mono",
        "Courier New",
        "monospace",
    ],
});

export const metadata: Metadata = {
    title: {
        default: "Xavryn — Local Raster to SVG Vectorizer",
        template: "%s | Xavryn",
    },
    description:
        "Turn raster images into clean, compact SVGs with smooth Bézier curves and fitted gradients locally in the browser.",
    keywords: [
        "raster to SVG",
        "image to SVG",
        "vectorize",
        "SVG converter",
        "bezier curves",
        "OKLab",
        "gradients",
        "browser-based",
        "client-side",
        "web worker",
        "illustration to vector",
    ],
    manifest: "/manifest.json",
    icons: {
        icon: [
            { rel: "icon", type: "image/png", sizes: "192x192", url: "/images/icon-192x192.png" },
            { rel: "icon", type: "image/png", sizes: "512x512", url: "/images/icon-512x512.png" },
        ],
        apple: [{ url: "/images/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
};

const themeScript = `try{var t=localStorage.getItem("theme");var d=t==="dark"||((t===null||t==="auto")&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
    return (
        <html lang="en" className={`${mono.variable} h-full antialiased`}>
            <head>
                <script dangerouslySetInnerHTML={{ __html: themeScript }} />
            </head>
            <body className="flex min-h-full flex-col">
                <ThemeProvider>{children}</ThemeProvider>
                <Analytics />
            </body>
        </html>
    );
}
