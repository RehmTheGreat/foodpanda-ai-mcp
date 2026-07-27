import { describe, it, expect } from 'vitest';
import { toCsv } from '../src/domain/csv.js';

describe('toCsv', () => {
  it('renders a header row and one row per record', () => {
    const out = toCsv(
      ['name', 'price'],
      [
        { name: 'Biryani', price: 256 },
        { name: 'Cola', price: 100 },
      ],
    );
    expect(out).toBe('name,price\nBiryani,256\nCola,100');
  });

  it('quotes values containing a comma, quote or newline', () => {
    const out = toCsv(['name'], [{ name: 'Biryani, Special "House" Style\nExtra' }]);
    expect(out).toBe('name\n"Biryani, Special ""House"" Style\nExtra"');
  });

  it('renders undefined or missing fields as empty', () => {
    expect(toCsv(['name', 'price'], [{ name: 'X' }])).toBe('name,price\nX,');
  });

  it('renders booleans and numbers as plain text', () => {
    expect(toCsv(['ok', 'n'], [{ ok: true, n: 0 }])).toBe('ok,n\ntrue,0');
  });

  it('produces just a header row for zero records', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b');
  });
});
