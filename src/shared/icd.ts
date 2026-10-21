// ICD chapters for the claims analysis (N10 E). The mapping is the WHO ICD-10 chapter list
// (version 2019, chapters I to XXII), with the ICD-10-CM categories that extend a chapter
// (D49, K94 to K95, V00, Y99) placed in it. A code is classified by its first three characters; an
// ICD-11 code, a malformed code or a blank is "Unclassified", never guessed. Only the chapter is
// derived: no diagnosis is ever invented from a code.

export const ICD_VERSION =
  'ICD-10 (WHO 2019 chapters; ICD-10-CM codes of the same chapters accepted)';

export interface IcdChapter {
  key: string;
  numeral: string;
  title: string;
  /** Inclusive range of three-character categories, for example A00 to B99. */
  from: string;
  to: string;
}

export const ICD10_CHAPTERS: readonly IcdChapter[] = [
  {
    key: 'I',
    numeral: 'I',
    title: 'Certain infectious and parasitic diseases',
    from: 'A00',
    to: 'B99',
  },
  { key: 'II', numeral: 'II', title: 'Neoplasms', from: 'C00', to: 'D49' },
  {
    key: 'III',
    numeral: 'III',
    title: 'Diseases of the blood and immune mechanism',
    from: 'D50',
    to: 'D89',
  },
  {
    key: 'IV',
    numeral: 'IV',
    title: 'Endocrine, nutritional and metabolic diseases',
    from: 'E00',
    to: 'E90',
  },
  { key: 'V', numeral: 'V', title: 'Mental and behavioural disorders', from: 'F00', to: 'F99' },
  { key: 'VI', numeral: 'VI', title: 'Diseases of the nervous system', from: 'G00', to: 'G99' },
  { key: 'VII', numeral: 'VII', title: 'Diseases of the eye and adnexa', from: 'H00', to: 'H59' },
  {
    key: 'VIII',
    numeral: 'VIII',
    title: 'Diseases of the ear and mastoid process',
    from: 'H60',
    to: 'H95',
  },
  { key: 'IX', numeral: 'IX', title: 'Diseases of the circulatory system', from: 'I00', to: 'I99' },
  { key: 'X', numeral: 'X', title: 'Diseases of the respiratory system', from: 'J00', to: 'J99' },
  { key: 'XI', numeral: 'XI', title: 'Diseases of the digestive system', from: 'K00', to: 'K95' },
  {
    key: 'XII',
    numeral: 'XII',
    title: 'Diseases of the skin and subcutaneous tissue',
    from: 'L00',
    to: 'L99',
  },
  {
    key: 'XIII',
    numeral: 'XIII',
    title: 'Diseases of the musculoskeletal system and connective tissue',
    from: 'M00',
    to: 'M99',
  },
  {
    key: 'XIV',
    numeral: 'XIV',
    title: 'Diseases of the genitourinary system',
    from: 'N00',
    to: 'N99',
  },
  {
    key: 'XV',
    numeral: 'XV',
    title: 'Pregnancy, childbirth and the puerperium',
    from: 'O00',
    to: 'O99',
  },
  {
    key: 'XVI',
    numeral: 'XVI',
    title: 'Certain conditions originating in the perinatal period',
    from: 'P00',
    to: 'P96',
  },
  {
    key: 'XVII',
    numeral: 'XVII',
    title: 'Congenital malformations and chromosomal abnormalities',
    from: 'Q00',
    to: 'Q99',
  },
  {
    key: 'XVIII',
    numeral: 'XVIII',
    title: 'Symptoms, signs and abnormal findings, not elsewhere classified',
    from: 'R00',
    to: 'R99',
  },
  {
    key: 'XIX',
    numeral: 'XIX',
    title: 'Injury, poisoning and certain other consequences of external causes',
    from: 'S00',
    to: 'T98',
  },
  {
    key: 'XX',
    numeral: 'XX',
    title: 'External causes of morbidity and mortality',
    from: 'V00',
    to: 'Y99',
  },
  {
    key: 'XXI',
    numeral: 'XXI',
    title: 'Factors influencing health status and contact with health services',
    from: 'Z00',
    to: 'Z99',
  },
  { key: 'XXII', numeral: 'XXII', title: 'Codes for special purposes', from: 'U00', to: 'U85' },
];

export const UNCLASSIFIED_CHAPTER = {
  key: 'UNCLASSIFIED',
  numeral: '—',
  title: 'Unclassified (no valid ICD-10 code)',
} as const;

/** An ICD-10 code as written: a letter, two digits, then an optional dot and up to 4 more. */
const ICD10 = /^([A-Z][0-9]{2})(?:\.?[0-9A-Z]{1,4})?$/;

/** The primary code of a cell: the first of several codes separated by , ; / or spaces. */
export function primaryIcdCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const first =
    text
      .trim()
      .toUpperCase()
      .split(/[\s,;/|]+/)[0] ?? '';
  return first === '' ? null : first;
}

/** The ICD-10 chapter of a code, or null when the code is blank, malformed or not ICD-10. */
export function icdChapterOf(code: string | null | undefined): IcdChapter | null {
  const primary = primaryIcdCode(code);
  if (!primary) return null;
  const match = ICD10.exec(primary);
  if (!match) return null;
  const category = match[1]!;
  return (
    ICD10_CHAPTERS.find((chapter) => category >= chapter.from && category <= chapter.to) ?? null
  );
}
