const openDialogs: HTMLElement[] = [];

export function registerDialog(dialog: HTMLElement) {
  openDialogs.push(dialog);
  return () => {
    const index = openDialogs.lastIndexOf(dialog);
    if (index !== -1) openDialogs.splice(index, 1);
  };
}

export function topmostDialog(scope?: HTMLElement | null) {
  const registered = openDialogs.filter((dialog) => (!scope || scope.contains(dialog)) && isVisible(dialog)).at(-1);
  return registered ?? (scope ? [...scope.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')].filter(isVisible).at(-1) : undefined);
}

export function isVisible(element: HTMLElement) {
  if (!element.isConnected || !element.getClientRects().length || element.closest('[inert], [hidden]')) return false;
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

export function focusableElements(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex], [contenteditable="true"]')]
    .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && isVisible(element));
}

export function restoreFocus(previous: HTMLElement | null, scope: HTMLElement | null) {
  const dialog = topmostDialog(scope);
  if (dialog && (!previous || !dialog.contains(previous))) {
    if (!dialog.contains(document.activeElement)) (focusableElements(dialog)[0] ?? dialog).focus({ preventScroll: true });
    return;
  }
  if (previous && previous !== document.body && previous !== document.documentElement && isVisible(previous) && !previous.matches(':disabled')) {
    previous.focus({ preventScroll: true });
    if (document.activeElement === previous) return;
  }
  if (dialog) {
    (focusableElements(dialog)[0] ?? dialog).focus({ preventScroll: true });
    return;
  }
  // A completed batch can remove the toolbar button that opened the dialog.
  const search = scope?.querySelectorAll<HTMLElement>('input[data-list-search], input[type="search"], input[placeholder="Search records"], input[aria-label*="search" i]');
  [...(search ?? [])].find((element) => isVisible(element) && !element.matches(':disabled'))?.focus({ preventScroll: true });
}
