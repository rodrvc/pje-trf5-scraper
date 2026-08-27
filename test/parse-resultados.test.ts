/**
 * Tests del parseo de resultados, contra HTML real capturado del sitio.
 *
 * Las fixtures son respuestas auténticas del PJe, no HTML inventado: así los
 * tests fallan si el sitio cambia de forma, que es justo lo que interesa
 * detectar.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  estaSaturada,
  extraerMensajeRechazo,
  parsearResultados,
  parsearRespuestaBusqueda,
} from '../src/domain/parse-resultados.js';

const fixture = (nombre: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', nombre), 'utf8');

const SATURADA = fixture('resultados-saturada.html');
const SIN_TOPE = fixture('resultados-sin-tope.html');
const RECHAZO = fixture('respuesta-rechazo.html');

describe('parsearResultados', () => {
  it('extrae las filas de una búsqueda real', () => {
    const resultados = parsearResultados(SATURADA);

    expect(resultados.length).toBeGreaterThan(0);
    expect(resultados.length).toBeLessThanOrEqual(30);
  });

  it('extrae número CNJ y token de detalle de cada fila', () => {
    const [primero] = parsearResultados(SATURADA);

    expect(primero?.numero).toMatch(/^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/);
    expect(primero?.ca).toMatch(/^[a-f0-9]+$/);
  });

  it('descompone la celda que mezcla clase, número, asunto y partes', () => {
    const resultados = parsearResultados(SATURADA);
    const conAsunto = resultados.find((r) => r.asunto !== undefined);
    const conPartes = resultados.find((r) => r.partes !== undefined);

    expect(conAsunto?.asunto).toBeTruthy();
    // Las partes se reconocen por el separador " X " entre polos.
    expect(conPartes?.partes).toContain(' X ');
  });

  it('conserva los acentos del portugués', () => {
    const resultados = parsearResultados(SATURADA);
    const texto = resultados.map((r) => r.claseJudicial ?? '').join(' ');

    // Si el encoding fuera incorrecto aparecería "APELAÃÃO".
    expect(texto).not.toContain('Ã§');
    expect(texto).not.toContain('ÃƒO');
  });

  it('no inventa filas cuando no hay tabla', () => {
    expect(parsearResultados('<html><body>nada</body></html>')).toEqual([]);
  });

  it('descarta filas sin número o sin token, que no sirven para nada', () => {
    const html = `
      <table id="fPP:processosTable"><tbody>
        <tr><td><a onclick="openPopUp('x','/listView.seam?ca=abc123')"></a></td>
            <td>SIN NUMERO AQUI</td><td>mov</td></tr>
      </tbody></table>`;

    expect(parsearResultados(html)).toEqual([]);
  });
});

describe('estaSaturada', () => {
  it('detecta el aviso del servidor', () => {
    expect(estaSaturada(SATURADA, 30)).toBe(true);
  });

  it('no marca saturada una búsqueda que devolvió pocos resultados', () => {
    expect(estaSaturada(SIN_TOPE, 10)).toBe(false);
  });

  it('marca saturada al llegar al tope aunque falte el aviso', () => {
    // Defensa: un recorte silencioso crearía un agujero de cobertura invisible.
    expect(estaSaturada('<html>sin aviso</html>', 30)).toBe(true);
  });

  it('no marca saturada por debajo del tope', () => {
    expect(estaSaturada('<html>sin aviso</html>', 29)).toBe(false);
  });
});

describe('extraerMensajeRechazo', () => {
  it('lee el motivo que el servidor devuelve en el panel de mensajes', () => {
    const mensaje = extraerMensajeRechazo(RECHAZO);

    expect(mensaje).toContain('dois nomes');
    // El acento debe sobrevivir: la respuesta AJAX viene en UTF-8.
    expect(mensaje).toContain('É necessário');
  });

  it('devuelve undefined cuando el panel está vacío', () => {
    expect(extraerMensajeRechazo(SIN_TOPE)).toBeUndefined();
  });
});

describe('parsearRespuestaBusqueda', () => {
  it('una búsqueda saturada devuelve resultados y la bandera de tope', () => {
    const respuesta = parsearRespuestaBusqueda(SATURADA);

    expect(respuesta.saturada).toBe(true);
    expect(respuesta.resultados.length).toBeGreaterThan(0);
  });

  it('una consulta rechazada no trae resultados pero sí el motivo', () => {
    const respuesta = parsearRespuestaBusqueda(RECHAZO);

    expect(respuesta.resultados).toEqual([]);
    expect(respuesta.mensajeRechazo).toContain('dois nomes');
  });

  it('una búsqueda normal no marca saturación', () => {
    const respuesta = parsearRespuestaBusqueda(SIN_TOPE);

    expect(respuesta.saturada).toBe(false);
    expect(respuesta.mensajeRechazo).toBeUndefined();
  });
});
