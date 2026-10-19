import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code drawn as SVG rectangles from the encoded module matrix. No HTML
 * string is injected and nothing is written anywhere; the value lives only in
 * the rendered element.
 */
export function QrCode({ value, label, size = 220 }: { value: string; label: string; size?: number }) {
  const matrix = useMemo(() => encode(value, { ecc: "M", border: 2 }), [value]);
  const path = useMemo(() => {
    const parts: string[] = [];
    matrix.data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) parts.push(`M${x} ${y}h1v1h-1z`);
      });
    });
    return parts.join("");
  }, [matrix]);
  return (
    <svg
      className="settings-mobile-qr"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      shapeRendering="crispEdges"
    >
      <rect width={matrix.size} height={matrix.size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
