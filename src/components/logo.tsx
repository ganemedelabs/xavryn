import Image from "next/image";

export default function Logo() {
    return (
        <div className="xavryn-logo relative h-8 w-8 shrink-0">
            <div className="xavryn-image relative h-full w-full">
                <Image
                    src="/images/logo.png"
                    width={32}
                    height={32}
                    alt=""
                    className="absolute inset-0 h-8 w-8 scale-110 object-contain opacity-50 blur-[6px] brightness-[1.1] saturate-150"
                />
                <Image
                    src="/images/logo.png"
                    width={32}
                    height={32}
                    alt=""
                    className="absolute inset-0 h-8 w-8 scale-105 object-contain opacity-70 blur-[3px] brightness-[1.3] saturate-175"
                />
                <Image
                    src="/images/logo.png"
                    width={32}
                    height={32}
                    alt=""
                    className="absolute inset-0 h-8 w-8 object-contain opacity-90 blur-[1px] brightness-[1.5] saturate-200"
                />

                <Image
                    src="/images/logo.png"
                    width={32}
                    height={32}
                    alt="Xavryn Logo"
                    className="relative z-10 h-8 w-8 object-contain saturate-125"
                />
            </div>

            <style>{`
                @property --xv-rx { syntax: "<angle>"; inherits: true; initial-value: 0deg; }
                @property --xv-ry { syntax: "<angle>"; inherits: true; initial-value: 0deg; }
                @property --xv-rz { syntax: "<angle>"; inherits: true; initial-value: 0deg; }
                @property --xv-x  { syntax: "<length>"; inherits: true; initial-value: 0px; }
                @property --xv-y  { syntax: "<length>"; inherits: true; initial-value: 0px; }

                @keyframes xv-rx {
                    0%, 100% { --xv-rx: 8deg; }
                    50%      { --xv-rx: -8deg; }
                }
                @keyframes xv-ry {
                    0%, 100% { --xv-ry: -12deg; }
                    50%      { --xv-ry: 12deg; }
                }
                @keyframes xv-rz {
                    0%, 100% { --xv-rz: -2deg; }
                    50%      { --xv-rz: 2deg; }
                }
                @keyframes xv-x {
                    0%, 100% { --xv-x: -1px; }
                    50%      { --xv-x: 1.5px; }
                }
                @keyframes xv-y {
                    0%, 100% { --xv-y: 0px; }
                    50%      { --xv-y: -3px; }
                }

                @keyframes xv-breathe {
                    0%, 100% { scale: 1; opacity: 0.85; }
                    50%      { scale: 1.06; opacity: 1; }
                }

                .xavryn-logo {
                    animation:
                        xv-rx 5.3s ease-in-out infinite,
                        xv-ry 7.1s ease-in-out infinite,
                        xv-rz 6.2s ease-in-out infinite,
                        xv-x 8.9s ease-in-out infinite,
                        xv-y 4.7s ease-in-out infinite;
                }

                .xavryn-image {
                    will-change: transform;
                    transform:
                        perspective(220px)
                        translate3d(var(--xv-x), var(--xv-y), 0)
                        rotateX(var(--xv-rx))
                        rotateY(var(--xv-ry))
                        rotateZ(var(--xv-rz));
                }

                @media (prefers-reduced-motion: reduce) {
                    .xavryn-logo,
                    .xavryn-image {
                        animation: none;
                        transform: none;
                    }
                }
            `}</style>
        </div>
    );
}

export function LogoDraft1() {
    return (
        <div className="xavryn-logo relative h-8 w-8 shrink-0">
            <div aria-hidden="true" className="xavryn-glow pointer-events-none absolute -inset-3">
                <Image
                    src="/images/logo.png"
                    width={32}
                    height={32}
                    alt=""
                    className="xavryn-glow-wide absolute inset-3 h-8 w-8 scale-110 object-contain brightness-[1.1] saturate-150"
                />

                <Image
                    src="/images/logo.png"
                    width={32}
                    height={32}
                    alt=""
                    className="xavryn-glow-medium absolute inset-3 h-8 w-8 scale-105 object-contain brightness-[1.3] saturate-175"
                />

                <Image
                    src="/images/logo.png"
                    width={32}
                    height={32}
                    alt=""
                    className="xavryn-glow-inner absolute inset-3 h-8 w-8 object-contain brightness-[1.5] saturate-200"
                />
            </div>

            <Image
                src="/images/logo.png"
                width={32}
                height={32}
                alt="Xavryn Logo"
                className="xavryn-crisp relative z-10 h-8 w-8 object-contain saturate-125"
            />

            <style>{`
                @property --xv-rx {
                    syntax: "<angle>";
                    inherits: true;
                    initial-value: 0deg;
                }

                @property --xv-ry {
                    syntax: "<angle>";
                    inherits: true;
                    initial-value: 0deg;
                }

                @property --xv-rz {
                    syntax: "<angle>";
                    inherits: true;
                    initial-value: 0deg;
                }

                @property --xv-x {
                    syntax: "<length>";
                    inherits: true;
                    initial-value: 0px;
                }

                @property --xv-y {
                    syntax: "<length>";
                    inherits: true;
                    initial-value: 0px;
                }

                @keyframes xv-rx {
                    0%, 100% { --xv-rx: 8deg; }
                    50%      { --xv-rx: -8deg; }
                }

                @keyframes xv-ry {
                    0%, 100% { --xv-ry: -12deg; }
                    50%      { --xv-ry: 12deg; }
                }

                @keyframes xv-rz {
                    0%, 100% { --xv-rz: -2deg; }
                    50%      { --xv-rz: 2deg; }
                }

                @keyframes xv-x {
                    0%, 100% { --xv-x: -1px; }
                    50%      { --xv-x: 1.5px; }
                }

                @keyframes xv-y {
                    0%, 100% { --xv-y: 0px; }
                    50%      { --xv-y: -3px; }
                }

                .xavryn-logo {
                    --xv-lift: clamp(
                        0px,
                        calc(var(--xv-y) * -1),
                        3px
                    );

                    --xv-progress: clamp(
                        0,
                        calc(var(--xv-lift) / 3px),
                        1
                    );

                    --xv-glow-opacity: calc(
                        0.85 - var(--xv-progress) * 0.4
                    );

                    --xv-blur-wide: calc(
                        6px + var(--xv-progress) * 6px
                    );

                    --xv-blur-medium: calc(
                        3px + var(--xv-progress) * 4.5px
                    );

                    --xv-blur-inner: calc(
                        1px + var(--xv-progress) * 2.4px
                    );

                    animation:
                        xv-rx 5.3s ease-in-out infinite,
                        xv-ry 7.1s ease-in-out infinite,
                        xv-rz 6.2s ease-in-out infinite,
                        xv-x 8.9s ease-in-out infinite,
                        xv-y 4.7s ease-in-out infinite;
                }

                .xavryn-crisp {
                    will-change: transform;

                    transform:
                        perspective(220px)
                        translate3d(
                            var(--xv-x),
                            var(--xv-y),
                            0
                        )
                        rotateX(var(--xv-rx))
                        rotateY(var(--xv-ry))
                        rotateZ(var(--xv-rz));
                }

                .xavryn-glow {
                    opacity: var(--xv-glow-opacity);

                    will-change: transform, opacity;

                    transform:
                        perspective(220px)
                        translate3d(
                            calc(var(--xv-x) * -1.2),
                            calc(var(--xv-y) * -1.2),
                            -6px
                        )
                        rotateX(calc(var(--xv-rx) * -1))
                        rotateY(calc(var(--xv-ry) * -1))
                        rotateZ(calc(var(--xv-rz) * -1));
                }

                .xavryn-glow-wide {
                    filter: blur(var(--xv-blur-wide));
                }

                .xavryn-glow-medium {
                    filter: blur(var(--xv-blur-medium));
                }

                .xavryn-glow-inner {
                    filter: blur(var(--xv-blur-inner));
                }

                @media (prefers-reduced-motion: reduce) {
                    .xavryn-logo {
                        animation: none;
                    }

                    .xavryn-crisp {
                        transform: none;
                    }

                    .xavryn-glow {
                        transform: none;
                        opacity: 0.85;
                    }
                }
            `}</style>
        </div>
    );
}
