"use client";

import { useId, useMemo } from "react";
import Button from "./button";

type Props = {
    copied: boolean;
    onCopy?: () => Promise<void>;
    text?: string | null;
};

function escapeHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function highlightSvgMarkup(svg: string): string {
    const commentPlaceholder: string[] = [];
    let out = svg.replace(/<!--[\s\S]*?-->/g, (match) => {
        const idx = commentPlaceholder.length;
        commentPlaceholder.push(`<span class="text-soft italic">${escapeHtml(match)}</span>`);
        return `@@COMMENT_${idx}@@`;
    });

    out = out.replace(
        /<(\/?)([a-zA-Z0-9:_-]+)([\s\S]*?)(\/?)>/g,
        (_full, slash: string, tagName: string, attrs: string, selfClose: string) => {
            const coloredAttrs = attrs.replace(
                /([a-zA-Z0-9:_-]+)(\s*=\s*)("[^"]*"|'[^']*')/g,
                (_m, attrName: string, eq: string, attrVal: string) =>
                    `<span class="text-ink/90">${escapeHtml(attrName)}</span>` +
                    `<span class="text-soft">${escapeHtml(eq)}</span>` +
                    `<span class="text-emerald-700 dark:text-emerald-400">${escapeHtml(attrVal)}</span>`
            );

            return (
                `<span class="text-soft">&lt;${slash}</span>` +
                `<span class="text-blue-700 dark:text-blue-400 font-medium">${escapeHtml(tagName)}</span>` +
                coloredAttrs +
                `<span class="text-soft">${selfClose}&gt;</span>`
            );
        }
    );

    out = out.replace(/@@COMMENT_(\d+)@@/g, (_m, i) => commentPlaceholder[Number(i)] ?? "");

    return out;
}

export default function SvgMarkupViewport({ onCopy, text, copied }: Props) {
    const headingId = useId();
    const highlightedHtml = useMemo(() => (text ? highlightSvgMarkup(text) : ""), [text]);

    return (
        <section
            aria-labelledby={headingId}
            className="border-line bg-panel/60 flex min-h-125 flex-1 flex-col overflow-hidden rounded-xl border shadow-xs"
        >
            <div className="border-line text-soft flex items-center justify-between border-b px-4 py-2.5 text-xs font-medium">
                <h2 id={headingId}>SVG Markup</h2>
                <Button
                    variant="icon:secondary"
                    size="sm"
                    onClick={onCopy}
                    disabled={!text}
                    aria-label={copied ? "Copied SVG markup to clipboard" : "Copy SVG markup to clipboard"}
                    aria-pressed={copied}
                    title={copied ? "Copied!" : "Copy SVG"}
                >
                    {copied ? (
                        <svg
                            aria-hidden="true"
                            className="size-4 text-emerald-600 dark:text-emerald-400"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                    ) : (
                        <svg
                            aria-hidden="true"
                            className="size-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={1.75}
                                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                            />
                        </svg>
                    )}
                </Button>
            </div>

            <div className="bg-panel relative min-h-110 flex-1 overflow-hidden">
                {text ? (
                    <pre
                        tabIndex={0}
                        aria-label="Generated SVG source code"
                        className="focus-visible:ring-accent absolute inset-0 m-0 scrollbar-gutter-stable overflow-y-scroll p-4 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
                        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
                    />
                ) : (
                    <p className="text-soft p-4 font-mono text-xs leading-relaxed">
                        Generated SVG markup will appear here.
                    </p>
                )}
            </div>
        </section>
    );
}
