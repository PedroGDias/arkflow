import {
  cloneElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

type Placement = 'top' | 'bottom'

type TooltipProps = {
  /** Text shown on hover and keyboard focus. */
  label: ReactNode
  placement?: Placement
  /**
   * Attach the hover behaviour to the child element itself instead of wrapping
   * it in a <span>. Use when a wrapper would break layout (e.g. CSS grid items).
   * Don't use for disabled controls — they don't emit pointer events, so the
   * wrapper span is what makes the tooltip work there.
   */
  asChild?: boolean
  children: ReactElement
}

type Anchor = { top: number; bottom: number; cx: number }

export function Tooltip({ label, placement = 'top', asChild = false, children }: TooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  const show = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setAnchor({ top: r.top, bottom: r.bottom, cx: r.left + r.width / 2 })
  }, [])
  const hide = useCallback(() => setAnchor(null), [])

  // Clamp the bubble inside the viewport so edge triggers don't overflow.
  useLayoutEffect(() => {
    const b = bubbleRef.current
    if (!anchor || !b) return
    const half = b.offsetWidth / 2
    const margin = 8
    const cx = Math.max(margin + half, Math.min(anchor.cx, window.innerWidth - margin - half))
    b.style.left = `${cx}px`
  }, [anchor])

  if (!label) return children

  const trigger = asChild ? (
    cloneElement(children as ReactElement<Record<string, unknown>>, {
      ref: triggerRef,
      onMouseEnter: (e: unknown) => {
        ;(children.props.onMouseEnter as ((e: unknown) => void) | undefined)?.(e)
        show()
      },
      onMouseLeave: (e: unknown) => {
        ;(children.props.onMouseLeave as ((e: unknown) => void) | undefined)?.(e)
        hide()
      },
      onFocus: (e: unknown) => {
        ;(children.props.onFocus as ((e: unknown) => void) | undefined)?.(e)
        show()
      },
      onBlur: (e: unknown) => {
        ;(children.props.onBlur as ((e: unknown) => void) | undefined)?.(e)
        hide()
      },
    })
  ) : (
    <span
      ref={triggerRef as React.Ref<HTMLSpanElement>}
      className="tt-wrap"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
    </span>
  )

  return (
    <>
      {trigger}
      {anchor &&
        createPortal(
          <div
            ref={bubbleRef}
            role="tooltip"
            className="tt-bubble"
            data-placement={placement}
            style={{ left: anchor.cx, top: placement === 'top' ? anchor.top : anchor.bottom }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  )
}
