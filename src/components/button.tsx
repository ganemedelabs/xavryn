import { cn } from "@/lib/utils";
import { ButtonHTMLAttributes, forwardRef } from "react";

export type ButtonVariant = keyof typeof VARIANT_CLASSES;
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    fullWidth?: boolean;
}

const STYLE_CLASSES = {
    primary:
        "bg-accent text-white shadow-sm hover:opacity-90 enabled:active:opacity-80 enabled:active:shadow-none focus-visible:ring-accent focus-visible:ring-offset-2",
    secondary:
        "border border-line bg-panel text-ink shadow-xs hover:bg-panel-subtle enabled:active:bg-line-subtle enabled:active:shadow-none focus-visible:ring-accent",
    ghost: "bg-transparent text-soft hover:bg-panel-subtle hover:text-ink enabled:active:bg-line-subtle enabled:active:text-ink focus-visible:ring-accent",
    link: "bg-transparent text-accent font-medium hover:underline enabled:active:opacity-70 focus-visible:ring-accent p-0 h-auto",
} as const;

const VARIANT_CLASSES = {
    primary: STYLE_CLASSES.primary,
    secondary: STYLE_CLASSES.secondary,
    ghost: STYLE_CLASSES.ghost,
    link: STYLE_CLASSES.link,
    "icon:primary": STYLE_CLASSES.primary,
    "icon:secondary": STYLE_CLASSES.secondary,
    "icon:ghost": STYLE_CLASSES.ghost,
    "icon:link": STYLE_CLASSES.link,
} as const satisfies Record<string, string>;

const SIZE_CLASSES: Record<ButtonSize, string> = {
    sm: "h-8 px-3 text-xs rounded-md gap-1.5",
    md: "h-9.5 px-4 text-sm rounded-lg gap-2",
    lg: "h-10.5 px-5 text-sm rounded-lg gap-2",
};

const ICON_SIZE_CLASSES: Record<ButtonSize, string> = {
    sm: "h-8 w-8 text-xs rounded-md",
    md: "h-9.5 w-9.5 text-sm rounded-lg",
    lg: "h-10.5 w-10.5 text-sm rounded-lg",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ variant = "secondary", size = "md", type = "button", className = "", disabled, children, ...props }, ref) => {
        const isIconVariant = variant.startsWith("icon:");
        const isLinkVariant = variant === "link" || variant === "icon:link";

        const baseClasses =
            "inline-flex cursor-pointer items-center justify-center font-medium transition focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 enabled:active:scale-[0.98]";

        const spacingClasses = variant === "link" ? "" : isIconVariant ? ICON_SIZE_CLASSES[size] : SIZE_CLASSES[size];

        return (
            <button
                ref={ref}
                type={type}
                disabled={disabled}
                className={cn(
                    baseClasses,
                    VARIANT_CLASSES[variant],
                    spacingClasses,
                    isLinkVariant ? "rounded enabled:active:scale-100" : "",
                    className
                )}
                {...props}
            >
                {children}
            </button>
        );
    }
);

Button.displayName = "Button";

export default Button;
