import { useCallback, useRef, useState, type PointerEvent } from 'react';

type ActivePan = {
  element: HTMLDivElement;
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
  moved: boolean;
};

/** Adds click-and-drag panning to scrollable document preview containers. */
export function useDragToPan() {
  const activePanRef = useRef<ActivePan | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, select, [data-no-pan]')) return;

    const element = event.currentTarget;
    activePanRef.current = {
      element,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startScrollLeft: element.scrollLeft,
      startScrollTop: element.scrollTop,
      moved: false,
    };

    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture may be unavailable in older browsers.
    }
  }, []);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const pan = activePanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - pan.startX;
    const deltaY = event.clientY - pan.startY;
    if (!pan.moved && Math.abs(deltaX) + Math.abs(deltaY) < 5) return;

    pan.moved = true;
    event.preventDefault();
    setIsDragging(true);
    pan.element.scrollLeft = pan.startScrollLeft - deltaX;
    pan.element.scrollTop = pan.startScrollTop - deltaY;
  }, []);

  const finishPan = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const pan = activePanRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;

    try {
      if (pan.element.hasPointerCapture(event.pointerId)) {
        pan.element.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore release errors during unmount or pointer cancellation.
    }

    activePanRef.current = null;
    setIsDragging(false);
  }, []);

  return {
    isDragging,
    panHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finishPan,
      onPointerCancel: finishPan,
      onLostPointerCapture: finishPan,
    },
  };
}
