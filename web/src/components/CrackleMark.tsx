interface CrackleMarkProps {
  size?: number
  className?: string
}

/** A roasted coffee bean with three crisp sound rays: the product name, not a cup. */
export function CrackleMark({ size = 24, className = '' }: CrackleMarkProps) {
  const classes = ['crackle-mark', className].filter(Boolean).join(' ')
  return (
    <svg
      aria-hidden="true"
      className={classes}
      focusable="false"
      height={size}
      viewBox="0 0 28 24"
      width={size * (28 / 24)}
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.9"
    >
      <path
        className="crackle-mark-bean"
        transform="translate(1 0)"
        d="M14.7 3.8c3.8 2.7 4 8.7.3 12.4-3.8 3.8-9.7 4.1-12.4.3-2.5-3.6-.5-9.1 3.6-11.8 3-2 6-2.1 8.8-.5Z"
      />
      <path
        className="crackle-mark-seam"
        transform="translate(1 0)"
        d="M4.3 17.4c3.2-.8 5.3-2.7 5.8-5.5.4-2.4 1.8-4.5 4.2-5.8"
      />
      <path className="crackle-mark-sound" d="m20 6.5 2.1-1.7M21.2 11h3M20 15.5l2.1 1.7" />
    </svg>
  )
}
