import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { aFechaFormulario, parsearCatalogoClases } from '../src/pje/busqueda.js';

const CATALOGO = readFileSync(
  join(import.meta.dirname, 'fixtures', 'catalogo-clases.html'),
  'utf8',
);

describe('aFechaFormulario', () => {
  it('convierte ISO al formato dd/MM/yyyy que espera el formulario', () => {
    expect(aFechaFormulario('2025-03-11')).toBe('11/03/2025');
    expect(aFechaFormulario('2026-12-01')).toBe('01/12/2026');
  });

  it('rechaza una fecha mal formada en vez de construir una consulta inválida', () => {
    expect(() => aFechaFormulario('11/03/2025')).toThrow(RangeError);
    expect(() => aFechaFormulario('')).toThrow(RangeError);
  });
});

describe('parsearCatalogoClases', () => {
  it('extrae el catálogo completo de la respuesta real del autocompletado', () => {
    const clases = parsearCatalogoClases(CATALOGO);

    // El sitio devuelve todas las clases de una vez, no solo las que coinciden.
    expect(clases.length).toBeGreaterThan(100);
  });

  it('empareja cada id interno con su nombre pese a las celdas de relleno', () => {
    const clases = parsearCatalogoClases(CATALOGO);
    const agravo = clases.find((c) => c.id === '202');

    expect(agravo?.nombre).toBe('AGRAVO DE INSTRUMENTO');
  });

  it('conserva los acentos del portugués', () => {
    const clases = parsearCatalogoClases(CATALOGO);

    expect(clases.some((c) => c.nombre.includes('AÇÃO'))).toBe(true);
    expect(clases.every((c) => !c.nombre.includes('Ã§'))).toBe(true);
  });

  it('todos los ids son numéricos, que es lo que espera el formulario', () => {
    const clases = parsearCatalogoClases(CATALOGO);

    expect(clases.every((c) => /^\d+$/.test(c.id))).toBe(true);
  });

  it('no repite clases', () => {
    const clases = parsearCatalogoClases(CATALOGO);
    const ids = new Set(clases.map((c) => c.id));

    expect(ids.size).toBe(clases.length);
  });

  it('devuelve lista vacía si la respuesta no trae sugerencias', () => {
    expect(parsearCatalogoClases('<html><body>nada</body></html>')).toEqual([]);
  });
});
