/**
 * Reference list for checking the pincode sheet: current states and union territories, and the
 * first digit(s) their PIN codes start with. Used only to report suspect rows; imported values
 * are never changed.
 */
const STATES: ReadonlyArray<readonly [name: string, pinFirstDigits: string]> = [
  ['Andhra Pradesh', '5'],
  ['Arunachal Pradesh', '7'],
  ['Assam', '7'],
  ['Bihar', '8'],
  ['Chhattisgarh', '4'],
  ['Goa', '4'],
  ['Gujarat', '3'],
  ['Haryana', '1'],
  ['Himachal Pradesh', '1'],
  ['Jharkhand', '8'],
  ['Karnataka', '5'],
  ['Kerala', '6'],
  ['Madhya Pradesh', '4'],
  ['Maharashtra', '4'],
  ['Manipur', '7'],
  ['Meghalaya', '7'],
  ['Mizoram', '7'],
  ['Nagaland', '7'],
  ['Odisha', '7'],
  ['Punjab', '1'],
  ['Rajasthan', '3'],
  ['Sikkim', '7'],
  ['Tamil Nadu', '6'],
  ['Telangana', '5'],
  ['Tripura', '7'],
  ['Uttar Pradesh', '2'],
  ['Uttarakhand', '2'],
  ['West Bengal', '7'],
  ['Andaman and Nicobar Islands', '7'],
  ['Chandigarh', '1'],
  ['Dadra and Nagar Haveli and Daman and Diu', '3'],
  ['Delhi', '1'],
  ['Jammu and Kashmir', '1'],
  ['Ladakh', '1'],
  ['Lakshadweep', '6'],
  // Puducherry includes Yanam (533xxx) as well as Puducherry, Karaikal and Mahe (6xxxxx).
  ['Puducherry', '56'],
];

/** Former names and misspellings, mapped to the current name. Used for suggestions only. */
const ALIASES: Readonly<Record<string, string>> = {
  orissa: 'Odisha',
  pondicherry: 'Puducherry',
  chattisgarh: 'Chhattisgarh',
  'anurachal pradesh': 'Arunachal Pradesh',
  'andaman and nicobar': 'Andaman and Nicobar Islands',
  'daman and diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'dadra and nagar haveli': 'Dadra and Nagar Haveli and Daman and Diu',
  uttaranchal: 'Uttarakhand',
  'nct of delhi': 'Delhi',
  'new delhi': 'Delhi',
};

function stateKey(name: string): string {
  return name.toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
}

const BY_KEY = new Map(STATES.map(([name, digits]) => [stateKey(name), { name, digits }]));

export interface StateMatch {
  /** The current state or UT name when the value names one (ignoring case and "&" vs "and"). */
  canonical: string | null;
  /** A suggested current name for a former name or misspelling. */
  suggestion: string | null;
}

export function matchState(value: string): StateMatch {
  const key = stateKey(value);
  const known = BY_KEY.get(key);
  if (known) return { canonical: known.name, suggestion: null };
  return { canonical: null, suggestion: ALIASES[key] ?? null };
}

/** First digits a PIN code in this state can start with, or null for an unknown state. */
export function pinFirstDigits(stateName: string): string | null {
  return BY_KEY.get(stateKey(stateName))?.digits ?? null;
}
