/**
 * The countries offered for "where my phone numbers are from" (Settings). A phone number said without its country code is read as a number of
 * this country; a number said WITH a code is read as it is, whatever is chosen here. India is the default.
 */
export interface CountryOption {
  /** ISO 3166-1 alpha-2. */
  readonly code: string;
  readonly name: string;
}

export const COUNTRY_OPTIONS: readonly CountryOption[] = [
  { code: 'IN', name: 'India (+91)' },
  { code: 'US', name: 'United States (+1)' },
  { code: 'GB', name: 'United Kingdom (+44)' },
  { code: 'CA', name: 'Canada (+1)' },
  { code: 'AU', name: 'Australia (+61)' },
  { code: 'NZ', name: 'New Zealand (+64)' },
  { code: 'AE', name: 'United Arab Emirates (+971)' },
  { code: 'SA', name: 'Saudi Arabia (+966)' },
  { code: 'QA', name: 'Qatar (+974)' },
  { code: 'KW', name: 'Kuwait (+965)' },
  { code: 'OM', name: 'Oman (+968)' },
  { code: 'BH', name: 'Bahrain (+973)' },
  { code: 'SG', name: 'Singapore (+65)' },
  { code: 'MY', name: 'Malaysia (+60)' },
  { code: 'LK', name: 'Sri Lanka (+94)' },
  { code: 'NP', name: 'Nepal (+977)' },
  { code: 'BD', name: 'Bangladesh (+880)' },
  { code: 'PK', name: 'Pakistan (+92)' },
  { code: 'ID', name: 'Indonesia (+62)' },
  { code: 'PH', name: 'Philippines (+63)' },
  { code: 'JP', name: 'Japan (+81)' },
  { code: 'CN', name: 'China (+86)' },
  { code: 'DE', name: 'Germany (+49)' },
  { code: 'FR', name: 'France (+33)' },
  { code: 'IT', name: 'Italy (+39)' },
  { code: 'ES', name: 'Spain (+34)' },
  { code: 'NL', name: 'Netherlands (+31)' },
  { code: 'IE', name: 'Ireland (+353)' },
  { code: 'ZA', name: 'South Africa (+27)' },
  { code: 'NG', name: 'Nigeria (+234)' },
  { code: 'KE', name: 'Kenya (+254)' },
  { code: 'BR', name: 'Brazil (+55)' },
  { code: 'MX', name: 'Mexico (+52)' },
];
