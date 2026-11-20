"use client";

import { createContext, ReactNode, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "auto";

type ThemeContextType = {
    theme: Theme;
    setTheme: (t: Theme) => void;
};

type Props = {
    children?: ReactNode;
};

const ThemeContext = createContext<ThemeContextType | null>(null);

export function ThemeProvider({ children }: Props) {
    const [theme, setTheme] = useState<Theme>(() => {
        if (typeof window !== "undefined") {
            const saved = localStorage.getItem("theme") as Theme | null;
            return saved || "auto";
        }
        return "auto";
    });

    useEffect(() => {
        const root = document.documentElement;
        const media = window.matchMedia("(prefers-color-scheme: dark)");

        const resolveDark = () => {
            if (theme === "dark") return true;
            if (theme === "light") return false;
            return media.matches;
        };

        const applyTheme = () => {
            if (resolveDark()) root.classList.add("dark");
            else root.classList.remove("dark");
        };

        applyTheme();

        localStorage.setItem("theme", theme);

        const onSystemChange = () => {
            if (theme === "auto") applyTheme();
        };

        media.addEventListener("change", onSystemChange);
        return () => media.removeEventListener("change", onSystemChange);
    }, [theme]);

    return <ThemeContext value={{ theme, setTheme }}>{children}</ThemeContext>;
}

export function useTheme() {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
    return ctx;
}
