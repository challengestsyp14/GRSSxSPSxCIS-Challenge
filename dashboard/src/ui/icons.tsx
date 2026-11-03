// Vector icons. Symbols are never left to font fallback.

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-4-4" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const DishIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 10a8 8 0 0 0 10 10" />
    <path d="M4 10l10 10" />
    <path d="M9 15l6-6" />
    <circle cx="16" cy="8" r="1.4" fill="currentColor" />
    <path d="M9 21h8" />
    <path d="M13 17v4" />
  </Svg>
);

export const BoltIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
  </Svg>
);

export const HijackIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 14c1.6-3 3.2-3 4.8 0s3.2 3 4.8 0" />
    <path d="M13 6l7-0v7" />
    <path d="M20 6l-7.5 7.5" />
  </Svg>
);

export const SpoofIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 10c0-3 4-5 9-5s9 2 9 5c0 4-3 7-5.5 7-1.8 0-2.3-2-3.5-2s-1.7 2-3.5 2C6 17 3 14 3 10z" />
    <circle cx="8.5" cy="10.5" r="1.6" fill="currentColor" />
    <circle cx="15.5" cy="10.5" r="1.6" fill="currentColor" />
  </Svg>
);

export const JamIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 12h3l2-6 3 12 3-14 3 16 2-8h4" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12.5l5 5L20 6.5" />
  </Svg>
);

export const CrossIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l10 18H2L12 3z" />
    <path d="M12 10v5" />
    <circle cx="12" cy="18" r="0.6" fill="currentColor" />
  </Svg>
);

export const LockIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Svg>
);

export const SatelliteIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="6" height="6" rx="1" />
    <path d="M3 5l4 4M17 19l4-4" />
    <rect x="1.5" y="3.5" width="5" height="4" transform="rotate(45 4 5.5)" />
    <rect x="17.5" y="16.5" width="5" height="4" transform="rotate(45 20 18.5)" />
    <path d="M14 18a4 4 0 0 0 4-4" />
  </Svg>
);

export const ArrowIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12h15M13 6l6 6-6 6" />
  </Svg>
);

export const BackIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12H5M11 6l-6 6 6 6" />
  </Svg>
);

export const PlayIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4l13 8-13 8z" fill="currentColor" />
  </Svg>
);

export const StopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
  </Svg>
);

export const KeyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
  </Svg>
);

export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3z" />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </Svg>
);

export const OrbitIcon = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(-20 12 12)" />
    <circle cx="12" cy="12" r="3" />
    <circle cx="20.5" cy="9" r="1.4" fill="currentColor" />
  </Svg>
);

export const ForestIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3l4.5 7h-3l3.5 5H3l3.5-5h-3L8 3z" />
    <path d="M8 15v6M16 8l3 4.5h-2l2.5 3.5H13" />
    <path d="M16 16v5" />
  </Svg>
);

export const CubeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2l9 5v10l-9 5-9-5V7l9-5z" />
    <path d="M3 7l9 5 9-5M12 12v10" />
  </Svg>
);

export const MouseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="3" width="12" height="18" rx="6" />
    <path d="M12 7v3" />
  </Svg>
);

export const TamperIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 12h3l2-3 2 6 1.5-3H17" />
  </Svg>
);

export const ATTACK_ICONS = {
  hijack: HijackIcon,
  spoof: SpoofIcon,
  jam: JamIcon,
  tamper: TamperIcon,
  cmdtamper: TamperIcon,
  cmdinject: BoltIcon,
  cmdreplay: ArrowIcon,
} as const;
