import type { SVGProps } from "react";

export type DashboardIconName =
  | "arrow-left"
  | "bell"
  | "block"
  | "chat"
  | "check"
  | "chevron"
  | "clock"
  | "copy"
  | "image"
  | "inbox"
  | "lock"
  | "logout"
  | "menu"
  | "more"
  | "plus"
  | "refresh"
  | "report"
  | "search"
  | "send"
  | "shield"
  | "users";

interface DashboardIconProps extends SVGProps<SVGSVGElement> {
  name: DashboardIconName;
}

export function DashboardIcon({
  name,
  className,
  ...props
}: DashboardIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      viewBox="0 0 24 24"
      {...props}
    >
      {iconPath(name)}
    </svg>
  );
}

function iconPath(name: DashboardIconName) {
  switch (name) {
    case "arrow-left":
      return (
        <>
          <path d="m15 18-6-6 6-6" />
          <path d="M9 12h10" />
        </>
      );
    case "bell":
      return (
        <>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
          <path d="M10 21h4" />
        </>
      );
    case "block":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m6 6 12 12" />
        </>
      );
    case "chat":
      return (
        <path d="M20 15a3 3 0 0 1-3 3H9l-5 3v-6a3 3 0 0 1-1-2V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v8Z" />
      );
    case "check":
      return <path d="m5 12 4 4L19 6" />;
    case "chevron":
      return <path d="m9 18 6-6-6-6" />;
    case "clock":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      );
    case "copy":
      return (
        <>
          <rect x="8" y="8" width="11" height="11" rx="2" />
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        </>
      );
    case "image":
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <circle cx="9" cy="9" r="2" />
          <path d="m4 17 5-5 4 4 2-2 5 4" />
        </>
      );
    case "inbox":
      return (
        <>
          <path d="M4 5h16v14H4z" />
          <path d="M4 14h4l2 2h4l2-2h4" />
        </>
      );
    case "lock":
      return (
        <>
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </>
      );
    case "logout":
      return (
        <>
          <path d="M10 5H5v14h5" />
          <path d="m15 8 4 4-4 4M19 12H9" />
        </>
      );
    case "menu":
      return (
        <>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </>
      );
    case "more":
      return (
        <>
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
        </>
      );
    case "plus":
      return <path d="M12 5v14M5 12h14" />;
    case "refresh":
      return (
        <>
          <path d="M20 7v5h-5" />
          <path d="M19 12a7 7 0 1 0-2 5" />
        </>
      );
    case "report":
      return (
        <>
          <path d="M6 21V4" />
          <path d="M6 5h11l-2 4 2 4H6" />
        </>
      );
    case "search":
      return (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="m16 16 4 4" />
        </>
      );
    case "send":
      return (
        <>
          <path d="m3 11 18-8-8 18-2-8-8-2Z" />
          <path d="m11 13 5-5" />
        </>
      );
    case "shield":
      return <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />;
    case "users":
      return (
        <>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2" />
          <path d="M16 4a3 3 0 0 1 0 6M18 13a4 4 0 0 1 3 4v2" />
        </>
      );
  }
}
