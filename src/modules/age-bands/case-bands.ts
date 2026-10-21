import {
  STANDARD_AGE_BANDS,
  STANDARD_AGE_BANDS_NAME,
  type AgeBand,
  type AgeBandSelection,
} from '../../shared/index.ts';
import type { AgeBandSelectionDoc, GhiCaseDoc } from '../ghi/ghi-case.model.ts';

// The bands a case's census summary, RFQ and selection summary use (N4): the copy the case was
// given, or the standard bands (as before N4). Kept apart from the master's service so the case
// records can use it without an import cycle.

export interface CaseBands {
  setId: string | null;
  name: string;
  revision: number | null;
  bands: AgeBand[];
}

const copy = (bands: readonly { label: string; min: number; max: number | null }[]): AgeBand[] =>
  bands.map((band) => ({ label: band.label, min: band.min, max: band.max }));

export function caseBands(doc: Pick<GhiCaseDoc, 'ageBandSelection'>): CaseBands {
  const selection = doc.ageBandSelection;
  if (!selection) {
    return {
      setId: null,
      name: STANDARD_AGE_BANDS_NAME,
      revision: null,
      bands: copy(STANDARD_AGE_BANDS),
    };
  }
  return {
    setId: selection.setId.toHexString(),
    name: selection.name,
    revision: selection.revision,
    bands: copy(selection.bands),
  };
}

/** The case's copy as the API returns it; names holds the users by id. */
export function selectionView(
  selection: AgeBandSelectionDoc | null | undefined,
  nameOf: (id: AgeBandSelectionDoc['selectedBy']) => string,
): AgeBandSelection | null {
  if (!selection) return null;
  return {
    setId: selection.setId.toHexString(),
    name: selection.name,
    revision: selection.revision,
    bands: copy(selection.bands),
    selectedAt: selection.selectedAt.toISOString(),
    selectedBy: nameOf(selection.selectedBy),
  };
}
