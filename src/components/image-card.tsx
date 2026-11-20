type Props = {
    title: string;
    src: string | null;
    loading?: boolean;
    alt?: string;
};

export default function ImageCard({ title, src, loading, alt }: Props) {
    const resolvedAlt = alt ?? `${title} preview`;

    return (
        <section
            aria-label={title}
            className="border-line bg-panel/60 flex min-h-105 flex-col overflow-hidden rounded-xl border shadow-xs"
        >
            <div className="border-line text-soft flex items-center justify-between border-b px-4 py-2.5 text-xs font-medium">
                <h2>{title}</h2>
                {loading && (
                    <span role="status" className="text-accent">
                        Updating…
                    </span>
                )}
            </div>
            <div
                className="relative flex flex-1 items-center justify-center overflow-auto p-6"
                style={{
                    backgroundImage: "radial-gradient(var(--line) 1px, transparent 1px)",
                    backgroundSize: "16px 16px",
                }}
            >
                {loading && (
                    <div aria-hidden="true" className="absolute inset-0 z-10 flex items-center justify-center">
                        <div className="border-accent h-7 w-7 animate-spin rounded-full border-2 border-t-transparent" />
                    </div>
                )}
                {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={src}
                        alt={resolvedAlt}
                        className={`max-h-[65vh] max-w-full object-contain shadow-md transition-all duration-300 motion-reduce:transition-none ${
                            loading ? "opacity-60 blur" : "blur-0"
                        }`}
                    />
                ) : (
                    <p className="text-soft text-xs">No preview available</p>
                )}
            </div>
        </section>
    );
}
