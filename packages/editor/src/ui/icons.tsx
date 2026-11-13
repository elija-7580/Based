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

// ADR 0016: Symbole des Block-Editors (Griff, Plus, Toggle) auf demselben 16er-Raster.
export function PlusIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
}

export function GripIcon() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
      {[3, 8, 13].map((y) => [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" fill="currentColor" />))}
    </svg>
  );
}

export function ChevronIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
