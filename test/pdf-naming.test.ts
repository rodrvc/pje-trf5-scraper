import { describe, expect, it } from 'vitest';

import type { CaseDocument } from '../src/domain/types.js';
import { caseDir, pdfPath, sanitiseSegment } from '../src/pje/pdf-naming.js';

function doc(overrides: Partial<CaseDocument> = {}): CaseDocument {
  return {
    date: '2026-01-15',
    name: 'Inteiro Teor',
    kind: 'Decisão',
    download: {
      idBin: '2674336',
      numeroDocumento: 'b42288900e7b81e72729d0133294526e00e193ac',
      nomeArqProcDocBin: 'Inteiro Teor',
      idProcessoDocumento: '2683486',
      actionMethod: 'ConsultaPublica/DetalheProcessoConsultaPublica/listView.xhtml',
    },
    ...overrides,
  };
}

describe('sanitiseSegment', () => {
  it('leaves an already-safe segment untouched', () => {
    expect(sanitiseSegment('0000001-23.2026.4.05.0000')).toBe('0000001-23.2026.4.05.0000');
  });

  it('replaces unsafe characters with underscore and collapses runs', () => {
    expect(sanitiseSegment('Acórdão / Decisão')).toBe('Acórdão_Decisão');
  });

  it('never returns an empty string', () => {
    expect(sanitiseSegment('///')).toBe('_');
    expect(sanitiseSegment('')).toBe('_');
  });

  it('cannot inject a path separator even from a maximally hostile input', () => {
    // Dots survive (CNJ numbers use them), but every `/` - the only thing
    // that actually lets a segment escape its directory - is stripped, so
    // the result can never traverse up or into another path.
    const result = sanitiseSegment('../../etc/passwd');
    expect(result).not.toContain('/');
  });

  it('rejects a segment that is only dots, so it cannot resolve to "." or ".."', () => {
    expect(sanitiseSegment('..')).toBe('_');
    expect(sanitiseSegment('.')).toBe('_');
    expect(sanitiseSegment('...')).toBe('_');
  });
});

describe('caseDir', () => {
  it('nests under the CNJ number, sanitised', () => {
    expect(caseDir('/root', '0000001-23.2026.4.05.0000')).toBe(
      '/root/0000001-23.2026.4.05.0000',
    );
  });
});

describe('pdfPath', () => {
  it('builds <date>_<kind>_<documentId>.pdf under the case directory', () => {
    const path = pdfPath('/root', '0000001-23.2026.4.05.0000', doc());
    expect(path).toBe('/root/0000001-23.2026.4.05.0000/2026-01-15_Decisão_2683486.pdf');
  });

  it('keeps two documents distinct by id even when their sanitised names collide', () => {
    const a = doc({
      kind: 'Decisão/Despacho',
      download: { ...doc().download, idProcessoDocumento: '111' },
    });
    const b = doc({
      kind: 'Decisão Despacho',
      download: { ...doc().download, idProcessoDocumento: '222' },
    });

    const pathA = pdfPath('/root', 'case', a);
    const pathB = pdfPath('/root', 'case', b);

    // Both sanitise to the same readable "kind" segment...
    expect(sanitiseSegment(a.kind)).toBe(sanitiseSegment(b.kind));
    // ...but the id keeps the files apart.
    expect(pathA).not.toBe(pathB);
    expect(pathA).toContain('111');
    expect(pathB).toContain('222');
  });

  it('falls back to a placeholder when date is missing, without crashing', () => {
    const path = pdfPath('/root', 'case', doc({ date: '' }));
    expect(path).toContain('undated');
  });

  it('caps the readable kind segment so an unbounded server-supplied name cannot blow past filesystem limits', () => {
    const hugeName = 'A'.repeat(500);
    const path = pdfPath('/root', 'case', doc({ kind: hugeName }));
    const fileName = path.split('/').pop() ?? '';
    // <date>_ + up to 80 chars of kind + _<id>.pdf
    expect(fileName.length).toBeLessThan(120);
    expect(fileName).toContain('2683486');
  });
});
