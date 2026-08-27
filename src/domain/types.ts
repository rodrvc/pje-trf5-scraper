/**
 * Tipos del dominio: procesos judiciales del PJe.
 *
 * La nomenclatura de los campos se mantiene en portugués cuando corresponde a
 * un término propio del sistema judicial brasileño (autuação, polo ativo,
 * movimentação). Traducirlos haría más difícil rastrear de dónde sale cada dato.
 */

/** Un participante del proceso: parte, abogado o representante. */
export interface Parte {
  nombre: string;
  /** Rol procesal: APELANTE, APELADO, ADVOGADO, etc. */
  tipo: string;
  /** Documento de identidad. Ausente en participantes que no lo publican. */
  documento?: { tipo: 'CPF' | 'CNPJ'; numero: string };
  /** Inscripción de abogado, cuando el participante lo es. */
  oab?: string;
  situacion?: string;
}

/** Una entrada del histórico de movimientos del proceso. */
export interface Movimentacao {
  /** Fecha en ISO 8601. */
  fecha: string;
  descripcion: string;
}

/**
 * Un documento adjunto al proceso.
 *
 * Los cuatro identificadores son los que exige el enlace de descarga; no se
 * pueden derivar unos de otros, así que se guardan todos.
 */
export interface Documento {
  /** Fecha en ISO 8601. */
  fecha: string;
  /** Nombre visible: "Despacho", "Acórdão"... */
  nombre: string;
  /** Tipo declarado por el sistema. */
  tipo: string;
  idBin: string;
  numeroDocumento: string;
  idProcessoDocumento: string;
  /** Ruta local del PDF, una vez descargado. */
  rutaLocal?: string;
}

/** Un proceso judicial con todo lo que la consulta pública expone. */
export interface Proceso {
  /** Número único CNJ. Es la clave de deduplicación. */
  numero: string;
  /**
   * Token de acceso al detalle. Verificado: no caduca con la sesión, así que
   * puede persistirse para reanudar sin repetir la búsqueda.
   */
  ca: string;

  claseJudicial?: string;
  asunto?: string;
  /** Fecha de autuación en ISO 8601. */
  fechaAutuacion?: string;
  jurisdiccion?: string;
  organoJulgador?: string;
  direccion?: string;
  procesoReferencia?: string;

  poloActivo: Parte[];
  poloPasivo: Parte[];
  movimentacoes: Movimentacao[];
  documentos: Documento[];

  /**
   * Proceso en segredo de justiça: el sistema devuelve detalle parcial o lo
   * deniega. No es un error, es un estado válido del dominio.
   */
  sigiloso: boolean;

  /** Momento de la extracción, en ISO 8601. */
  extraidoEn: string;
}

/** Una fila de la tabla de resultados, antes de entrar al detalle. */
export interface ResultadoBusqueda {
  numero: string;
  ca: string;
  claseJudicial?: string;
  asunto?: string;
  partes?: string;
  ultimaMovimentacao?: string;
}

/**
 * Criterios de una consulta.
 *
 * El barrido genera muchas de estas, cada vez más acotadas, hasta que ninguna
 * llegue al tope de 30 que impone el sitio.
 */
export interface Consulta {
  /** Inicio del rango de autuación, en ISO 8601. */
  desde: string;
  /** Fin del rango de autuación, en ISO 8601. */
  hasta: string;
  /** Id interno de la clase judicial, para la segunda dimensión de partición. */
  claseJudicialId?: string;
  /** Nombre de la clase, que el formulario exige junto con el id. */
  claseJudicialNombre?: string;
}

/** Resultado de ejecutar una consulta. */
export interface RespuestaBusqueda {
  resultados: ResultadoBusqueda[];
  /**
   * La consulta llegó al tope y hay resultados que no se ven. Quien la reciba
   * debe subdividir la consulta en vez de dar la cobertura por completa.
   */
  saturada: boolean;
  /** Mensaje de rechazo del servidor, si validó y descartó la consulta. */
  mensajeRechazo?: string;
}

/** Una clase judicial del catálogo, para particionar. */
export interface ClaseJudicial {
  id: string;
  nombre: string;
}
