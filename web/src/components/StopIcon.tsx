interface StopIconProps {
  size?: number
}

/**
 * One unmistakable Stop symbol everywhere: a solid square inside a circle.
 * The filled center prevents the icon from reading as an empty checkbox.
 */
export function StopIcon({ size = 18 }: StopIconProps) {
  return (
    <svg
      className="stop-icon"
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor" />
    </svg>
  )
}
