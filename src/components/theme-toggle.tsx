import { KeyboardEvent, ReactNode, useRef, useSyncExternalStore } from "react";
import Button from "./button";
import { useTheme } from "./theme-provider";

type Theme = "light" | "dark" | "auto";

const icon = (children: ReactNode) => (
    <svg
        className="size-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
    >
        {children}
    </svg>
);

const OPTIONS: { value: Theme; label: string; icon: ReactNode }[] = [
    {
        value: "light",
        label: "Light theme",
        icon: icon(
            <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </>
        ),
    },
    {
        value: "auto",
        label: "System theme",
        icon: icon(
            <>
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
            </>
        ),
    },
    {
        value: "dark",
        label: "Dark theme",
        icon: icon(<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />),
    },
];

const subscribe = () => () => {};

export default function ThemeToggle() {
    const { theme, setTheme } = useTheme();
    const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const mounted = useSyncExternalStore(
        subscribe,
        () => true,
        () => false
    );

    const activeValue: Theme = mounted ? theme : "auto";

    const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex: number | null = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            nextIndex = (index + 1) % OPTIONS.length;
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            nextIndex = (index - 1 + OPTIONS.length) % OPTIONS.length;
        }

        if (nextIndex !== null) {
            e.preventDefault();
            const nextOption = OPTIONS[nextIndex];
            setTheme(nextOption.value);
            buttonRefs.current[nextIndex]?.focus();
        }
    };

    return (
        <div
            role="radiogroup"
            aria-label="Color theme"
            className="bg-panel border-line inline-flex rounded-lg border p-1 shadow-xs"
        >
            {OPTIONS.map((o, idx) => {
                const active = activeValue === o.value;
                return (
                    <Button
                        key={o.value}
                        ref={(el) => {
                            buttonRefs.current[idx] = el as HTMLButtonElement;
                        }}
                        variant={active ? "icon:primary" : "icon:ghost"}
                        role="radio"
                        size="sm"
                        aria-checked={active}
                        aria-label={o.label}
                        title={o.label}
                        tabIndex={active ? 0 : -1}
                        onClick={() => setTheme(o.value)}
                        onKeyDown={(e) => handleKeyDown(e, idx)}
                    >
                        {o.icon}
                    </Button>
                );
            })}
        </div>
    );
}
