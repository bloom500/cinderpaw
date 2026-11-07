/**
 * A phone number with its country: the WhatsApp number to link.
 *
 * Continue stays locked until the number is a real length for the country
 * picked (1 Nov, Darius: 11 digits where Romania has 9 must not go through),
 * and the line under the field says why. What leaves is the full
 * international form, +40712345678, so the engine never guesses a prefix.
 */
import { useMemo, useState } from 'react';
import {
  getCountries,
  getCountryCallingCode,
  getExampleNumber,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  validatePhoneNumberLength,
  type CountryCode,
} from 'libphonenumber-js';
import examples from 'libphonenumber-js/mobile/examples';

const regionName = (() => {
  try {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    return (c: string) => names.of(c) ?? c;
  } catch {
    return (c: string) => c;
  }
})();

const COUNTRIES = getCountries()
  .map((code) => ({ code, name: regionName(code), dial: getCountryCallingCode(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Why Continue is locked, in words; null when the number is good to send.
 * No country yet is a reason too: the prefix is picked by the person, never
 * guessed from the computer's language (1 Nov, Darius).
 */
export function phoneProblem(text: string, country: CountryCode | ''): string | null {
  if (!text.trim()) return '';
  if (!country) return 'Choose the country first, for its prefix.';
  if (isValidPhoneNumber(text, country)) return null;
  const name = regionName(country);
  const length = validatePhoneNumberLength(text, country);
  if (length === 'TOO_SHORT') return `Too short for a ${name} number.`;
  if (length === 'TOO_LONG') return `Too long for a ${name} number.`;
  return `This is not a ${name} number. Check the digits and the country.`;
}

export function PhoneField({ initial, onSubmit }: { initial?: string; onSubmit: (e164: string) => void }) {
  const start = useMemo(() => (initial ? parsePhoneNumberFromString(initial) : undefined), [initial]);
  // Only a number the person saved before fills it in.
  const [country, setCountry] = useState<CountryCode | ''>(() => start?.country ?? '');
  const [text, setText] = useState(() => start?.formatNational() ?? '');
  const problem = phoneProblem(text, country);
  const example = country ? getExampleNumber(country, examples)?.formatNational() : undefined;

  const submit = () => {
    if (problem !== null || !country) return;
    const parsed = parsePhoneNumberFromString(text, country);
    if (parsed) onSubmit(parsed.number);
  };

  const box =
    'h-9 rounded border border-border-default bg-bg-primary text-sm text-text-primary focus:outline-hidden focus:ring-1 focus:ring-brand/50';
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-1.5"
    >
      <div className="flex items-center gap-2">
        <select
          aria-label="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value as CountryCode)}
          className={`${box} w-56 shrink-0 px-2 ${country ? '' : 'text-text-muted'}`}
        >
          <option value="" disabled>
            Choose country
          </option>
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name} +{c.dial}
            </option>
          ))}
        </select>
        <input
          autoFocus
          type="tel"
          autoComplete="tel-national"
          aria-label="Phone number"
          aria-invalid={!!problem}
          placeholder={example ?? ''}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={`${box} min-w-0 flex-1 px-2 placeholder:text-text-muted`}
        />
        <button
          type="submit"
          disabled={problem !== null}
          className="h-9 shrink-0 rounded bg-brand px-3 text-xs font-medium text-on-brand transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continue
        </button>
      </div>
      {problem && <p className="text-xs text-text-muted">{problem}{country && example ? ` Example: ${example}` : ''}</p>}
    </form>
  );
}
