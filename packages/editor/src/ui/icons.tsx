// BSD-290: Icons des Editors, die BlockNote nicht mitbringt. Gleiches Raster wie der Based-Satz (24 px, 2 px Strich,
// runde Enden); @based/editor hat keinen Zugriff auf apps/web/src/icons.tsx.

/** „View full size“: zwei Pfeile nach außen. */
export function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}
