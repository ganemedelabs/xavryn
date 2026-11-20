"use client";

import { ReactNode, useEffect, useId, useRef, useState } from "react";

type Props = {
    label: ReactNode;
    value: number;
    min: number;
    max: number;
    step: number;
    defaultValue?: number;
    onChange: (val: number) => void;
    valueFormatter?: (val: number) => string;
};

export default function SliderControl({ label, value, min, max, step, defaultValue, onChange, valueFormatter }: Props) {
    const inputId = useId();
    const valueId = useId();
    const isDraggingRef = useRef(false);

    const [dragValue, setDragValue] = useState<number | null>(null);

    const effectiveValue = dragValue ?? value;
    const rangeSpan = max - min;
    const clampedValue = Math.min(max, Math.max(min, effectiveValue));
    const percentage = rangeSpan > 0 ? ((clampedValue - min) / rangeSpan) * 100 : 0;
    const formattedValue = valueFormatter ? valueFormatter(effectiveValue) : String(effectiveValue);

    useEffect(() => {
        const stopDragging = () => {
            if (isDraggingRef.current) {
                isDraggingRef.current = false;
                setDragValue(null);
            }
        };

        window.addEventListener("pointerup", stopDragging);
        window.addEventListener("pointercancel", stopDragging);
        return () => {
            window.removeEventListener("pointerup", stopDragging);
            window.removeEventListener("pointercancel", stopDragging);
        };
    }, []);

    const handleInput = (raw: string) => {
        const parsed = parseFloat(raw);
        if (Number.isNaN(parsed)) return;
        if (isDraggingRef.current) {
            setDragValue(parsed);
        }
        onChange(parsed);
    };

    const handleDoubleClick = () => {
        if (typeof defaultValue === "number" && defaultValue !== value) {
            const next = Math.min(max, Math.max(min, defaultValue));
            setDragValue(null);
            onChange(next);
        }
    };

    return (
        <div className="group space-y-2 py-0.5">
            <div className="flex items-center justify-between gap-2 text-xs">
                <label
                    htmlFor={inputId}
                    onDoubleClick={handleDoubleClick}
                    title={typeof defaultValue === "number" ? "Double-click to reset to default" : undefined}
                    className="text-ink cursor-pointer font-medium select-none"
                >
                    {label}
                </label>
                <output
                    id={valueId}
                    htmlFor={inputId}
                    className="bg-panel-subtle border-line text-ink rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-none tabular-nums"
                >
                    {formattedValue}
                </output>
            </div>

            <div className="relative flex h-4 items-center">
                <div
                    aria-hidden="true"
                    className="bg-line pointer-events-none h-1.5 w-full overflow-hidden rounded-full"
                >
                    <div
                        className="bg-accent h-full rounded-full"
                        style={{
                            width: `${percentage}%`,
                        }}
                    />
                </div>

                <input
                    id={inputId}
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={effectiveValue}
                    aria-valuemin={min}
                    aria-valuemax={max}
                    aria-valuenow={effectiveValue}
                    aria-valuetext={formattedValue}
                    onPointerDown={() => {
                        isDraggingRef.current = true;
                    }}
                    onDoubleClick={handleDoubleClick}
                    onInput={(e) => handleInput((e.target as HTMLInputElement).value)}
                    onChange={(e) => handleInput(e.target.value)}
                    className="slider-input focus-visible:ring-accent absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                />
            </div>

            <style>{`
                .slider-input::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    appearance: none;
                    width: 14px;
                    height: 14px;
                    border-radius: 9999px;
                    background: var(--accent);
                    border: 2px solid var(--panel, #ffffff);
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
                    cursor: pointer;
                }

                .slider-input:hover::-webkit-slider-thumb,
                .group:hover .slider-input::-webkit-slider-thumb {
                    transform: scale(1.1);
                }

                .slider-input:active::-webkit-slider-thumb {
                    transform: scale(1.15);
                }

                .slider-input::-moz-range-thumb {
                    width: 14px;
                    height: 14px;
                    border-radius: 9999px;
                    background: var(--accent);
                    border: 2px solid var(--panel, #ffffff);
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
                    cursor: pointer;
                }

                .slider-input:hover::-moz-range-thumb,
                .group:hover .slider-input::-moz-range-thumb {
                    transform: scale(1.1);
                }

                .slider-input:active::-moz-range-thumb {
                    transform: scale(1.15);
                }

                .slider-input::-moz-range-track {
                    background: transparent;
                    border: none;
                }
            `}</style>
        </div>
    );
}
