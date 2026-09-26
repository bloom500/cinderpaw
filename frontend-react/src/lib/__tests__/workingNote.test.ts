import { describe, expect, it } from 'vitest';
import { isWorkingNote } from '../workingNote';

// The real segments from the 26 Sep space-bunny-alpha reply, and the kind of
// answer that must stay in the reply.
describe('isWorkingNote', () => {
  it('takes the narration a model writes before a tool call', () => {
    expect(isWorkingNote('Hai să verific ce e real, nu din memorie.')).toBe(true);
    expect(isWorkingNote('Greșea mea — am scris `notebook.ctx`, care nu există în notebook. Starea sunt doar variabilele. Reiau:')).toBe(true);
    expect(isWorkingNote('Notebook-ul îmi dă doar contoare. Cer lista direct:')).toBe(true);
  });

  it('leaves an answer in the reply: long, or with structure', () => {
    expect(isWorkingNote('Da, Darius. **Nizoral 2%** e prima alegere.\n\n| Varianta | Buget |\n|---|---|')).toBe(false);
    expect(isWorkingNote('Trei variante:\n- Nizoral\n- Seboderm\n- Ketoconazol generic')).toBe(false);
    expect(isWorkingNote('## Ce pot face userii aici\nFișiere și cod.')).toBe(false);
    expect(isWorkingNote('x'.repeat(281))).toBe(false);
    expect(isWorkingNote('   ')).toBe(false);
  });
});
