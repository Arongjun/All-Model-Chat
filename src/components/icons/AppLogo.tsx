import React, { useId } from 'react';

export const AppLogo: React.FC<{ className?: string; style?: React.CSSProperties; ariaLabel?: string }> = ({
  className,
  style,
  ariaLabel = '阿荣AI工作站 Logo',
}) => {
  const idPrefix = useId().replace(/:/g, '');
  const primaryGradientId = `arongLogoPrimary-${idPrefix}`;
  const beamGradientId = `arongLogoBeam-${idPrefix}`;
  const glowGradientId = `arongLogoGlow-${idPrefix}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 270 72"
      className={className}
      style={style}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={primaryGradientId} x1="12" y1="10" x2="252" y2="66" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00E5FF" />
          <stop offset="0.38" stopColor="#2D7CFF" />
          <stop offset="0.72" stopColor="#7C3DFF" />
          <stop offset="1" stopColor="#00F5B8" />
        </linearGradient>
        <linearGradient id={beamGradientId} x1="16" y1="62" x2="260" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00F5B8" />
          <stop offset="0.5" stopColor="#00D7FF" />
          <stop offset="1" stopColor="#FFFFFF" />
        </linearGradient>
        <radialGradient id={glowGradientId} cx="0" cy="0" r="1" gradientTransform="matrix(108 0 0 34 122 34)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00E5FF" stopOpacity="0.38" />
          <stop offset="1" stopColor="#00E5FF" stopOpacity="0" />
        </radialGradient>
      </defs>

      <ellipse cx="122" cy="34" rx="108" ry="34" fill={`url(#${glowGradientId})`} />
      <path
        d="M31 61 56 13h18l25 48H81l-4.7-9.9H52.9L48.2 61H31Zm27.1-22.9h12.8L64.5 24l-6.4 14.1ZM102.5 61V13h36.2c12.5 0 21.1 7.2 21.1 18.1 0 7.6-4.2 13.5-11 16.3L162.6 61h-20.2l-11.5-11.8h-10.8V61h-17.6Zm17.6-25.1h16.6c3.6 0 5.9-1.9 5.9-4.8 0-3-2.3-4.9-5.9-4.9h-16.6v9.7ZM166 61l24-48h18l24 48h-17.8l-4.4-9.8h-22.7l-4.3 9.8H166Zm27.2-22.7h10.5l-5.3-12.7-5.2 12.7ZM240.5 61V13h18.2v48h-18.2Z"
        fill={`url(#${primaryGradientId})`}
      />
      <path
        d="M18 57h34M78 20h38M124 44h50M189 38h22M238 20h24"
        fill="none"
        stroke={`url(#${beamGradientId})`}
        strokeLinecap="round"
        strokeWidth="3.4"
      />
      <path
        d="M190 13h-7.4l-8.2 48h7.4l8.2-48ZM252.5 13h-5.6l-6 48h5.6l6-48Z"
        fill="white"
        opacity="0.55"
      />
      <circle cx="262" cy="14" r="4.3" fill="#00F5B8" />
      <circle cx="24" cy="18" r="3.2" fill="#00E5FF" />
    </svg>
  );
};
