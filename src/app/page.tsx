"use client";

import Button from "@/components/button";
import ImageCard from "@/components/image-card";
import Logo from "@/components/logo";
import SliderControl from "@/components/slide-control";
import SvgMarkupViewport from "@/components/svg-markup-viewport";
import ThemeToggle from "@/components/theme-toggle";
import { autoTune, loadImageData, pickCrops } from "@/lib/auto-tune";
import { OPTIONS } from "@/lib/img-to-svg";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ConversionOptions = {
    [K in keyof typeof OPTIONS]: number;
};

function getDefaultOptions(): ConversionOptions {
    const defaults = {} as ConversionOptions;
    for (const key of Object.keys(OPTIONS) as (keyof typeof OPTIONS)[]) {
        defaults[key] = OPTIONS[key].default;
    }
    return defaults;
}

function isSvgFile(target: File) {
    return target.type === "image/svg+xml" || /\.svg$/i.test(target.name);
}

function isSupportedRasterImage(target: File) {
    const ALLOWED_RASTER_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/avif"];

    if (isSvgFile(target)) return false;
    if (ALLOWED_RASTER_MIME_TYPES.includes(target.type)) return true;
    return !target.type && /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(target.name);
}

interface ActiveTooltip {
    key: string;
    text: string;
    top: number;
    left: number;
    pinned: boolean;
}

const VIEW_MODES = [
    { id: "split", label: "Side by Side" },
    { id: "svg", label: "Vector SVG" },
    { id: "original", label: "Original" },
    { id: "code", label: "SVG Markup" },
] as const;

export default function HomePage() {
    const [file, setFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [svgOutput, setSvgOutput] = useState<string | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [stats, setStats] = useState<{
        width: number;
        height: number;
        durationMs: number;
        sizeKb: string;
    } | null>(null);

    const [options, setOptions] = useState<ConversionOptions>(getDefaultOptions);
    const [viewMode, setViewMode] = useState<(typeof VIEW_MODES)[number]["id"]>("split");
    const [copied, setCopied] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [tooltip, setTooltip] = useState<ActiveTooltip | null>(null);
    const [statusAnnouncement, setStatusAnnouncement] = useState("");

    const [isTuning, setIsTuning] = useState(false);
    const [tuneProgress, setTuneProgress] = useState(0);
    const [tuneInfo, setTuneInfo] = useState<{ err: number; sizeKb: string } | null>(null);

    const tuneAbortRef = useRef<AbortController | null>(null);
    const workerRef = useRef<Worker | null>(null);
    const jobIdRef = useRef(0);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

    const svgUrl = useMemo(() => {
        if (!svgOutput) return null;
        const blob = new Blob([svgOutput], { type: "image/svg+xml;charset=utf-8" });
        return URL.createObjectURL(blob);
    }, [svgOutput]);

    useEffect(() => {
        const worker = new Worker(new URL("../workers/svg.worker.ts", import.meta.url));
        workerRef.current = worker;

        return () => {
            worker.terminate();
        };
    }, []);

    useEffect(() => {
        return () => {
            if (previewUrl) URL.revokeObjectURL(previewUrl);
        };
    }, [previewUrl]);

    useEffect(() => {
        return () => {
            if (svgUrl) URL.revokeObjectURL(svgUrl);
        };
    }, [svgUrl]);

    useEffect(() => {
        if (!tooltip) return;

        const dismiss = (e: Event) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest("[data-tooltip-trigger]") || target?.closest("[data-tooltip-popover]")) {
                return;
            }
            setTooltip(null);
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setTooltip(null);
            }
        };

        window.addEventListener("pointerdown", dismiss);
        window.addEventListener("scroll", dismiss, true);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("pointerdown", dismiss);
            window.removeEventListener("scroll", dismiss, true);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [tooltip]);

    useEffect(() => () => tuneAbortRef.current?.abort(), []);

    const openTooltip = (
        e: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>,
        key: string,
        text: string,
        pinned: boolean
    ) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const tooltipWidth = 260;
        const left = Math.min(rect.left, window.innerWidth - tooltipWidth - 16);
        const top = rect.bottom + 6;

        setTooltip((prev) => {
            if (pinned && prev?.key === key && prev.pinned) {
                return null;
            }
            return { key, text, top, left: Math.max(16, left), pinned };
        });
    };

    const processImage = useCallback(async (targetFile: File, currentOptions: ConversionOptions) => {
        if (!workerRef.current) return;

        setIsProcessing(true);
        setError(null);
        setStatusAnnouncement("Vectorizing image...");
        const currentJobId = ++jobIdRef.current;

        try {
            const bmp = await createImageBitmap(targetFile);
            const canvas = document.createElement("canvas");
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Could not initialize 2D canvas context");

            ctx.drawImage(bmp, 0, 0);
            const imageData = ctx.getImageData(0, 0, bmp.width, bmp.height);
            bmp.close();

            workerRef.current.onmessage = (e: MessageEvent) => {
                if (e.data.id !== jobIdRef.current) return;
                setIsProcessing(false);

                if (e.data.error) {
                    setError(e.data.error);
                    setStatusAnnouncement("");
                    return;
                }

                const { svg, durationMs } = e.data;
                const sizeKb = (new Blob([svg]).size / 1024).toFixed(1);
                setSvgOutput(svg);
                setStats({
                    width: imageData.width,
                    height: imageData.height,
                    durationMs,
                    sizeKb,
                });
                setStatusAnnouncement(`SVG conversion complete. File size ${sizeKb} kilobytes.`);
            };

            workerRef.current.postMessage(
                {
                    id: currentJobId,
                    imageData,
                    options: currentOptions,
                },
                [imageData.data.buffer]
            );
        } catch (err: unknown) {
            if (currentJobId === jobIdRef.current) {
                setIsProcessing(false);
                setError((err as Error)?.message || "Failed to read image file.");
                setStatusAnnouncement("");
            }
        }
    }, []);

    const handleFileSelect = (selectedFile: File | undefined) => {
        if (!selectedFile) return;
        if (!isSupportedRasterImage(selectedFile)) {
            setError(
                isSvgFile(selectedFile)
                    ? "SVG files are not supported. Please upload a raster image (PNG, JPG, WebP, GIF, etc.)."
                    : "Please upload a valid raster image file (PNG, JPG, WebP, GIF, etc.)."
            );
            if (fileInputRef.current) fileInputRef.current.value = "";
            return;
        }

        setFile(selectedFile);
        setPreviewUrl(URL.createObjectURL(selectedFile));
        processImage(selectedFile, options);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const droppedFile = e.dataTransfer.files?.[0];
        handleFileSelect(droppedFile);
    };

    const handleDropzoneKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
        }
    };

    const handleOptionChange = <K extends keyof ConversionOptions>(key: K, value: ConversionOptions[K]) => {
        const next = { ...options, [key]: value };
        setOptions(next);
    };

    const handleAutoTune = async () => {
        if (!file) return;
        tuneAbortRef.current?.abort();
        const ac = new AbortController();
        tuneAbortRef.current = ac;
        setIsTuning(true);
        setTuneProgress(0);
        setError(null);
        setStatusAnnouncement("Auto-tuning parameters started.");

        try {
            const CROP_SIZE = 512;

            const working = await loadImageData(file, options.maxSize);
            const crops = pickCrops(working, CROP_SIZE);

            const cropMax = Math.max(...crops.map((c) => Math.max(c.width, c.height)));
            const base = { ...options, maxSize: Math.max(cropMax, 64) };

            const best = await autoTune(
                crops,
                base,
                (cur, done, total) => {
                    setTuneProgress(done / total);
                    setTuneInfo({ err: cur.err, sizeKb: cur.kb.toFixed(1) });
                },
                { budget: 64, offspring: 8, signal: ac.signal }
            );
            if (ac.signal.aborted) {
                setStatusAnnouncement("Auto-tuning cancelled.");
                return;
            }

            const finalOptions = { ...best.opts, maxSize: options.maxSize } as ConversionOptions;
            setOptions(finalOptions);
            setStatusAnnouncement("Auto-tuning complete. Re-rendering SVG.");
            await processImage(file, finalOptions);
        } catch (err) {
            if (!ac.signal.aborted) {
                setError((err as Error)?.message || "Auto-tune failed.");
                setStatusAnnouncement("");
            }
        } finally {
            setIsTuning(false);
        }
    };

    const handleDownload = () => {
        if (!svgUrl || !file) return;
        const a = document.createElement("a");
        const baseName = file.name.replace(/\.[^/.]+$/, "");
        a.href = svgUrl;
        a.download = `${baseName}.svg`;
        a.click();
    };

    const handleCopySvg = async () => {
        if (!svgOutput) return;
        await navigator.clipboard.writeText(svgOutput);
        setCopied(true);
        setStatusAnnouncement("SVG code copied to clipboard.");
        setTimeout(() => setCopied(false), 2000);
    };

    const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex: number | null = null;
        if (e.key === "ArrowRight") {
            nextIndex = (index + 1) % VIEW_MODES.length;
        } else if (e.key === "ArrowLeft") {
            nextIndex = (index - 1 + VIEW_MODES.length) % VIEW_MODES.length;
        } else if (e.key === "Home") {
            nextIndex = 0;
        } else if (e.key === "End") {
            nextIndex = VIEW_MODES.length - 1;
        }

        if (nextIndex !== null) {
            e.preventDefault();
            setViewMode(VIEW_MODES[nextIndex].id);
            tabRefs.current[nextIndex]?.focus();
        }
    };

    return (
        <div className="bg-ground text-ink flex min-h-screen flex-col">
            {/* Skip to Main Content Link */}
            <a
                href="#main-workspace"
                className="focus:bg-accent sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg"
            >
                Skip to workspace
            </a>

            {/* Screen-Reader Live Region for Async Announcements */}
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {statusAnnouncement}
            </div>

            {/* Header */}
            <header className="border-line bg-panel/80 flex flex-wrap items-center justify-between gap-4 border-b px-6 py-4 backdrop-blur">
                <div className="flex items-center gap-3">
                    <Logo />
                    <div>
                        <h1 className="text-lg font-semibold tracking-tight">Xavryn</h1>
                        <p className="text-soft text-xs">OKLab region segmentation &amp; Bézier gradient fitting</p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {svgOutput && (
                        <>
                            <Button variant="secondary" onClick={handleCopySvg}>
                                {copied ? (
                                    <span className="flex gap-0.5">
                                        Copied
                                        <svg
                                            aria-hidden="true"
                                            className="size-5 text-emerald-600 dark:text-emerald-400"
                                            fill="none"
                                            stroke="currentColor"
                                            viewBox="0 0 24 24"
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                strokeWidth={2}
                                                d="M5 13l4 4L19 7"
                                            />
                                        </svg>
                                    </span>
                                ) : (
                                    "Copy SVG"
                                )}
                            </Button>
                            <Button variant="primary" onClick={handleDownload}>
                                Download SVG
                            </Button>
                        </>
                    )}
                </div>
            </header>

            {/* Main Content */}
            <main className="grid flex-1 grid-cols-1 lg:grid-cols-12">
                {/* Sidebar Controls */}
                <aside
                    aria-label="Conversion settings"
                    className="border-line bg-panel/40 flex flex-col gap-6 border-b p-5 lg:col-span-3 lg:border-r lg:border-b-0"
                >
                    {/* Upload Trigger */}
                    <div>
                        <input
                            ref={fileInputRef}
                            type="file"
                            aria-label="Upload raster image"
                            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
                            onChange={(e) => handleFileSelect(e.target.files?.[0])}
                            className="hidden"
                        />
                        <Button variant="secondary" className="w-full" onClick={() => fileInputRef.current?.click()}>
                            {file ? "Replace Image" : "Choose Image"}
                        </Button>
                    </div>

                    {/* Parameters Header & Reset */}
                    <div className="flex items-center justify-between">
                        <h2
                            id="parameters-heading"
                            className="text-soft text-xs font-semibold tracking-wider uppercase"
                        >
                            Parameters
                        </h2>
                        <Button
                            variant="link"
                            onClick={() => {
                                const defaults = getDefaultOptions();
                                setOptions(defaults);
                                setStatusAnnouncement("Parameters reset to defaults.");
                                if (file) processImage(file, defaults);
                            }}
                            className="text-xs font-medium"
                        >
                            Reset
                        </Button>
                    </div>

                    {/* Scrollable Sliders Container */}
                    <div
                        role="group"
                        aria-labelledby="parameters-heading"
                        tabIndex={0}
                        className="focus-visible:ring-accent max-h-[55vh] space-y-4 overflow-y-auto rounded pr-1 focus-visible:ring-2 focus-visible:outline-none"
                    >
                        {(
                            Object.entries(OPTIONS) as [keyof typeof OPTIONS, (typeof OPTIONS)[keyof typeof OPTIONS]][]
                        ).map(([key, spec]) => {
                            const value = options[key];
                            const isTooltipOpen = tooltip?.key === key;
                            const tooltipId = `tooltip-${String(key)}`;

                            let step = spec.integer ? 1 : (spec.max - spec.min) / 100;
                            if (!spec.integer && step > 0.01) step = 0.001;

                            const customLabel = (
                                <div className="flex items-center gap-1.5">
                                    <span className="text-ink text-xs font-medium">{spec.label}</span>
                                    <Button
                                        variant="icon:secondary"
                                        data-tooltip-trigger
                                        aria-label={`Help for ${spec.label}`}
                                        aria-expanded={isTooltipOpen}
                                        aria-describedby={isTooltipOpen ? tooltipId : undefined}
                                        onMouseEnter={(e) => {
                                            if (!tooltip?.pinned) {
                                                openTooltip(e, String(key), spec.description, false);
                                            }
                                        }}
                                        onMouseLeave={() => {
                                            if (!tooltip?.pinned) {
                                                setTooltip(null);
                                            }
                                        }}
                                        onFocus={(e) => {
                                            if (!tooltip?.pinned) {
                                                openTooltip(e, String(key), spec.description, false);
                                            }
                                        }}
                                        onBlur={() => {
                                            if (!tooltip?.pinned) {
                                                setTooltip(null);
                                            }
                                        }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            openTooltip(e, String(key), spec.description, true);
                                        }}
                                        className={`text-soft h-4 w-4 rounded-full text-[10px] font-semibold ${
                                            isTooltipOpen ? "border-accent text-accent" : ""
                                        }`}
                                    >
                                        ?
                                    </Button>
                                </div>
                            );

                            return (
                                <div key={key} className="relative">
                                    <SliderControl
                                        label={customLabel}
                                        value={value}
                                        min={spec.min}
                                        max={spec.max}
                                        step={step}
                                        onChange={(v) => handleOptionChange(key, v)}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {file && (
                        <div className="space-y-2">
                            <Button
                                variant="primary"
                                onClick={() => processImage(file, options)}
                                disabled={isProcessing}
                                aria-busy={isProcessing}
                                className="w-full text-sm font-medium"
                            >
                                {isProcessing ? "Tracing Vector..." : "Re-render SVG"}
                            </Button>

                            {isTuning ? (
                                <Button
                                    variant="secondary"
                                    onClick={() => tuneAbortRef.current?.abort()}
                                    disabled={isProcessing}
                                    className="w-full text-sm font-medium"
                                >
                                    Cancel auto-tune
                                </Button>
                            ) : (
                                <Button
                                    variant="secondary"
                                    onClick={handleAutoTune}
                                    disabled={isProcessing}
                                    className="w-full text-sm font-medium"
                                >
                                    <span aria-hidden="true">✨ </span>Auto-tune parameters{" "}
                                    <span className="bg-panel-subtle text-ink rounded px-1.5 py-0.5 align-middle font-mono text-[10px]">
                                        BETA
                                    </span>
                                </Button>
                            )}

                            {isTuning && (
                                <div className="space-y-1.5">
                                    <div
                                        role="progressbar"
                                        aria-label="Auto-tune progress"
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={Math.round(tuneProgress * 100)}
                                        className="bg-line h-1.5 w-full overflow-hidden rounded-full"
                                    >
                                        <div
                                            className="bg-accent h-full transition-all"
                                            style={{ width: `${Math.round(tuneProgress * 100)}%` }}
                                        />
                                    </div>
                                    {tuneInfo && (
                                        <p className="text-soft font-mono text-xs">
                                            Best so far: error {tuneInfo.err.toFixed(4)}
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Stats Box */}
                    {stats && (
                        <dl
                            aria-label="Output statistics"
                            className="border-line bg-panel text-soft mt-auto space-y-1.5 rounded-lg border p-3.5 text-xs shadow-xs"
                        >
                            <div className="flex justify-between">
                                <dt>Dimensions:</dt>
                                <dd className="text-ink font-mono">
                                    {stats.width} x {stats.height}
                                </dd>
                            </div>
                            <div className="flex justify-between">
                                <dt>SVG Size:</dt>
                                <dd className="text-ink font-mono">{stats.sizeKb} KB</dd>
                            </div>
                            <div className="flex justify-between">
                                <dt>Render Time:</dt>
                                <dd className="text-ink font-mono">{stats.durationMs} ms</dd>
                            </div>
                        </dl>
                    )}
                </aside>

                {/* Preview Area */}
                <section
                    id="main-workspace"
                    aria-label="Image preview and SVG workspace"
                    className="flex flex-col gap-4 p-6 lg:col-span-9"
                >
                    {error && (
                        <div
                            role="alert"
                            className="rounded-lg border border-red-800/70 bg-red-950/50 px-4 py-3 text-sm text-red-200"
                        >
                            {error}
                        </div>
                    )}

                    {!file ? (
                        <div
                            role="button"
                            tabIndex={0}
                            aria-label="Upload image dropzone. Drop an image here, or press Enter or Space to browse."
                            onKeyDown={handleDropzoneKeyDown}
                            onDragOver={(e) => {
                                e.preventDefault();
                                setIsDragging(true);
                            }}
                            onDragLeave={() => setIsDragging(false)}
                            onDrop={handleDrop}
                            onClick={() => fileInputRef.current?.click()}
                            className={`focus-visible:ring-accent flex min-h-105 flex-1 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed p-8 text-center transition focus-visible:ring-2 focus-visible:outline-none ${
                                isDragging
                                    ? "border-accent bg-accent-soft"
                                    : "border-line hover:border-soft bg-panel/30"
                            }`}
                        >
                            <div
                                aria-hidden="true"
                                className="bg-panel border-line text-soft mb-4 flex h-12 w-12 items-center justify-center rounded-full border shadow-xs"
                            >
                                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={1.75}
                                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                                    />
                                </svg>
                            </div>
                            <p className="text-ink text-base font-medium">Drop an image here, or click to browse</p>
                            <p className="text-soft mt-1 text-xs">
                                Supports PNG, JPG, WebP, GIF — processed locally in your browser
                            </p>
                        </div>
                    ) : (
                        <>
                            {/* View Switcher Bar */}
                            <div className="flex items-center justify-between">
                                <div
                                    role="tablist"
                                    aria-label="Preview view modes"
                                    className="bg-panel border-line inline-flex rounded-lg border p-1 shadow-xs"
                                >
                                    {VIEW_MODES.map((tab, idx) => {
                                        const isSelected = viewMode === tab.id;
                                        return (
                                            <Button
                                                key={tab.id}
                                                ref={(el) => {
                                                    tabRefs.current[idx] = el;
                                                }}
                                                id={`tab-${tab.id}`}
                                                variant={isSelected ? "primary" : "ghost"}
                                                role="tab"
                                                size="sm"
                                                aria-selected={isSelected}
                                                aria-controls="preview-tabpanel"
                                                tabIndex={isSelected ? 0 : -1}
                                                onClick={() => setViewMode(tab.id)}
                                                onKeyDown={(e) => handleTabKeyDown(e, idx)}
                                                className={`text-xs font-medium ${
                                                    isSelected ? "shadow-xs" : "text-soft"
                                                }`}
                                            >
                                                {tab.label}
                                            </Button>
                                        );
                                    })}
                                </div>

                                {isProcessing && (
                                    <span aria-hidden="true" className="text-accent animate-pulse text-xs font-medium">
                                        Vectorizing pixels...
                                    </span>
                                )}
                            </div>

                            {/* Viewport */}
                            <div
                                id="preview-tabpanel"
                                role="tabpanel"
                                aria-labelledby={`tab-${viewMode}`}
                                className="flex flex-1 flex-col"
                            >
                                {viewMode === "code" ? (
                                    <SvgMarkupViewport copied={copied} onCopy={handleCopySvg} text={svgOutput} />
                                ) : (
                                    <div
                                        className={`grid flex-1 gap-4 ${
                                            viewMode === "split" ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"
                                        }`}
                                    >
                                        {(viewMode === "split" || viewMode === "original") && (
                                            <ImageCard title="Original Raster" src={previewUrl} />
                                        )}
                                        {(viewMode === "split" || viewMode === "svg") && (
                                            <ImageCard title="Vectorized SVG" src={svgUrl} loading={isProcessing} />
                                        )}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </section>
            </main>

            {/* Footer */}
            <footer className="border-line bg-panel/80 flex flex-wrap items-center justify-between gap-4 border-t px-6 py-4 text-xs backdrop-blur">
                <p className="text-soft">
                    This project is open source and available on{" "}
                    <a
                        href="https://github.com/ganemedelabs/xavryn"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-ink focus-visible:ring-accent rounded font-medium underline hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
                    >
                        GitHub
                        <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                    .
                </p>

                <div className="flex items-center gap-2">
                    <ThemeToggle />
                </div>
            </footer>

            {/* Floating Tooltip Popover */}
            {tooltip && (
                <div
                    id={`tooltip-${tooltip.key}`}
                    data-tooltip-popover
                    role="tooltip"
                    style={{ top: tooltip.top, left: tooltip.left }}
                    className="border-line bg-panel text-ink fixed z-50 w-65 rounded-lg border p-3 text-xs leading-relaxed shadow-lg"
                >
                    {tooltip.text}
                </div>
            )}
        </div>
    );
}
