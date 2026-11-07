import { describe, expect, it } from 'vitest';
import { readCsv } from '../TablePreview';
import { isCsvFile } from '@/stores/artifacts';

// 31 Oct: a CSV the agent saved as a file showed as raw "Categorie,Sumă" text in the panel.
describe('a CSV file reads as a table', () => {
  it('keeps quoted commas, doubled quotes and line breaks inside a cell', () => {
    const csv = 'Company,Phone,Address\r\n"Just Property Care Ltd","07742 645753","87 Royle Green Road,\nNorthenden"\n"Say ""hi""",1,x\n';
    expect(readCsv(csv)).toEqual({
      columns: ['Company', 'Phone', 'Address'],
      rows: [
        ['Just Property Care Ltd', '07742 645753', '87 Royle Green Road,\nNorthenden'],
        ['Say "hi"', '1', 'x'],
      ],
    });
  });

  it('takes the separator the header uses', () => {
    expect(readCsv('Categorie;Sumă\nCărți;120')).toEqual({ columns: ['Categorie', 'Sumă'], rows: [['Cărți', '120']] });
  });

  it('is no table with one column or no rows', () => {
    expect(readCsv('just a line\nanother')).toBeNull();
    expect(readCsv('a,b')).toBeNull();
  });

  it('is told apart by its name, as a file or as code', () => {
    expect(isCsvFile('file', 'roofing-leads-manchester-20.csv')).toBe(true);
    expect(isCsvFile('code', 'roofers-manchester-20.csv ')).toBe(true);
    expect(isCsvFile('code', 'script.py')).toBe(false);
    expect(isCsvFile('document', 'notes.csv')).toBe(false);
  });
});
