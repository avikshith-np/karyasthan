// The sidebar on a phone: a panel sliding in from the left, opened by the topbar's menu button.
// Same element and same links as on desktop, where none of this applies. While it's open the
// page behind it is inert, so Tab stays in the panel. Closes on Escape, a tap on the scrim, a
// swipe to the left and navigation; focus goes back to the button (on navigation, to the page).
// Nothing here touches the DOM at import time.
const SWIPE_CLOSE_PX = 70;
const SWIPE_START_PX = 8;

export function initDrawer({ sidebar, button, backdrop, main, content }) {
  let isOpen = false;

  function setOpen(next, { focusTo = button } = {}) {
    if (next === isOpen) return;
    isOpen = next;
    sidebar.classList.toggle('is-open', next);
    backdrop.classList.toggle('is-open', next);
    document.documentElement.classList.toggle('drawer-open', next);
    main.inert = next;
    button.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      const target = sidebar.querySelector('a.nav-link.active') || sidebar.querySelector('a.nav-link');
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
    } else {
      sidebar.style.transform = '';
      focusTo?.focus?.({ preventScroll: true });
    }
  }

  button.addEventListener('click', () => setOpen(!isOpen));
  backdrop.addEventListener('click', () => setOpen(false));

  // Capture: an Escape here must not also close a panel on the page behind.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      e.stopPropagation();
      setOpen(false);
    }
  }, true);

  // A tap on the link to the page you're already on changes no hash, so close here too.
  sidebar.addEventListener('click', (e) => {
    if (isOpen && e.target.closest('a')) setOpen(false, { focusTo: content });
  });

  // Swipe left to dismiss. Vertical scrolling stays with the browser (touch-action: pan-y).
  let startX = null;
  let startY = 0;
  let moved = 0;
  sidebar.addEventListener('pointerdown', (e) => {
    if (!isOpen) return;
    startX = e.clientX;
    startY = e.clientY;
    moved = 0;
  });
  sidebar.addEventListener('pointermove', (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    if (!moved && (dx > -SWIPE_START_PX || Math.abs(e.clientY - startY) > Math.abs(dx))) return;
    moved = dx;
    sidebar.classList.add('is-dragging');
    sidebar.style.transform = `translateX(${Math.min(0, dx)}px)`;
  });
  const drop = () => {
    if (startX === null) return;
    startX = null;
    sidebar.classList.remove('is-dragging');
    sidebar.style.transform = '';
    if (moved < -SWIPE_CLOSE_PX) setOpen(false);
  };
  sidebar.addEventListener('pointerup', drop);
  sidebar.addEventListener('pointercancel', drop);
  // The click that ends a swipe isn't a tap on a link.
  sidebar.addEventListener('click', (e) => {
    if (moved) { e.preventDefault(); e.stopPropagation(); moved = 0; }
  }, true);

  // Leaving phone width (a rotated tablet, a resized window) drops it.
  window.matchMedia?.('(min-width: 901px)').addEventListener?.('change', () => setOpen(false));

  return {
    /** Navigation: close, with focus moving on to the page. */
    closeForNav: () => setOpen(false, { focusTo: content }),
    isOpen: () => isOpen,
  };
}
