type P = { size?: number; className?: string };

const base = (size = 14) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: "ic",
});

export const IconSearch = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </svg>
);

export const IconCopy = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
    <path d="M10.5 3.5H4a1.5 1.5 0 0 0-1.5 1.5v6" />
  </svg>
);

export const IconEye = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="1.9" />
  </svg>
);

export const IconEyeOff = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M2.5 6.2C1.9 7 1.5 8 1.5 8S4 12.5 8 12.5c1 0 1.9-.3 2.7-.7M6 3.9c.6-.2 1.3-.4 2-.4 4 0 6.5 4.5 6.5 4.5s-.6 1.1-1.7 2.2" />
    <path d="M2.5 2.5l11 11" />
  </svg>
);

export const IconStar = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m8 2.6 1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.3l-3.4 1.8.7-3.8L2.5 6.6l3.8-.5L8 2.6Z" />
  </svg>
);

export const IconPlus = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </svg>
);

export const IconDots = ({ size, className }: P) => (
  <svg {...base(size)} className={className} stroke="none" fill="currentColor">
    <circle cx="3.2" cy="8" r="1.1" />
    <circle cx="8" cy="8" r="1.1" />
    <circle cx="12.8" cy="8" r="1.1" />
  </svg>
);

export const IconChevronDown = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </svg>
);

export const IconChevronRight = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m6.5 4.5 3.5 3.5-3.5 3.5" />
  </svg>
);

export const IconX = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
  </svg>
);

export const IconCheck = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="m3.5 8.5 3 3 6-6.5" />
  </svg>
);

export const IconShield = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M8 1.8 13 3.6v4.2c0 3-2 5.4-5 6.4-3-1-5-3.4-5-6.4V3.6L8 1.8Z" />
  </svg>
);

export const IconLink = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M6.4 9.6 9.6 6.4" />
    <path d="M7.6 4.4 8.8 3.2a2.4 2.4 0 0 1 3.4 3.4l-1.2 1.2" />
    <path d="M8.4 11.6l-1.2 1.2A2.4 2.4 0 0 1 3.8 9.4l1.2-1.2" />
  </svg>
);

export const IconClock = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 4.8V8l2.2 1.4" />
  </svg>
);

export const IconLock = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="7" width="10" height="7" rx="2" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);

export const IconGear = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.6v1.6M8 12.8v1.6M2.7 8H1.1m13.8 0h-1.6M4.2 4.2 3.1 3.1m9.8 9.8-1.1-1.1M11.8 4.2l1.1-1.1M4.2 11.8l-1.1 1.1" />
  </svg>
);

export const IconKey = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <circle cx="5.5" cy="10.5" r="3" />
    <path d="m7.8 8.2 5-5M10.6 3.4l2.2 2.2" />
  </svg>
);

export const IconFingerprint = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M3.2 8a4.8 4.8 0 0 1 9.6 0v3M5.4 8a2.6 2.6 0 0 1 5.2 0v4.4M8 5.6v6" />
  </svg>
);

export const IconTrash = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M2.8 4.4h10.4M6 4.4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.4M4.2 4.4l.6 8.2a1.2 1.2 0 0 0 1.2 1.1h4a1.2 1.2 0 0 0 1.2-1.1l.6-8.2" />
  </svg>
);

export const IconRefresh = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
    <path d="M13.2 2.6V5h-2.4" />
  </svg>
);

export const IconEdit = ({ size, className }: P) => (
  <svg {...base(size)} className={className}>
    <path d="M9.6 3.2 12.8 6.4 6 13.2H2.8v-3.2z" />
  </svg>
);
