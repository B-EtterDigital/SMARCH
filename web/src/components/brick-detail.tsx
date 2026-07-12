import { useEffect, useRef } from "preact/hooks";
import { reportClientError } from "../lib/api";
import { STRINGS } from "../strings";
import { BrickCard, type BrickCardState } from "./brick-card";
import type { BrickRecord } from "./brick-model";

interface BrickDetailProps {
  brick?: BrickRecord | null;
  onClose: () => void;
  open: boolean;
  state?: BrickCardState;
}

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Focus-trapped, right-side brick inspector. Escape closes it and focus returns
 * to the invoking control; panel motion is reduced to opacity when requested.
 */
export function BrickDetail({ brick, onClose, open, state }: BrickDetailProps) {
  const panelRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) {
      reportClientError("ui.brick-detail.focus", "error", new Error(STRINGS.brickDetail.panelMissing));
      return;
    }
    panel.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!controls.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus.current?.focus();
    };
  }, [onClose, open]);

  return (
    <div class={open ? "brick-detail-layer brick-detail-layer--open" : "brick-detail-layer"} aria-hidden={!open}>
      <button class="brick-detail__scrim" type="button" tabIndex={open ? 0 : -1} onClick={onClose} aria-label={STRINGS.brickDetail.close} />
      <aside class="brick-detail" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="brick-detail-title" tabIndex={-1}>
        <header class="brick-detail__header"><h2 id="brick-detail-title">{STRINGS.brickDetail.title}</h2><button type="button" onClick={onClose} aria-label={STRINGS.brickDetail.close}><span aria-hidden="true">{STRINGS.brickDetail.closeMark}</span></button></header>
        <div class="brick-detail__body"><BrickCard brick={brick} state={state} /></div>
      </aside>
    </div>
  );
}
