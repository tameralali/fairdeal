// The Aquarium's mark: a fish on a square of the table's felt. (A fish is what poker players call a
// weak player; an aquarium is a room full of them.)
const FELT = '#507a4e';
const CREAM = '#f4f1e8';

// size in pixels; label for screen readers (empty when the name is written beside it)
export function fishSVG(size = 28, label = '') {
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="fish" width="${size}" height="${size}" viewBox="0 0 32 32" ${a11y}><rect width="32" height="32" rx="9" fill="${FELT}"/>`
    + `<path d="M27 16c0 4.4-4.6 8-10.2 8-4.2 0-7.1-2.2-8.6-4.6L4 23V9l4.2 3.6C9.7 10.2 12.6 8 16.8 8 22.4 8 27 11.6 27 16z" fill="${CREAM}"/>`
    + `<path d="M14.6 8.3c1.1-1.9 3.1-3 5.4-3-.6 1.3-.9 2.4-.8 3.3" fill="${CREAM}"/>`
    + `<circle cx="21.6" cy="14.8" r="1.6" fill="${FELT}"/></svg>`;
}

// The fish and the name, as at the top of every page.
export function wordmarkHTML(size = 28) {
  return `${fishSVG(size)}<span>The Aquarium</span>`;
}
