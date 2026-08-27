/**
 * Domain types: PJe legal cases.
 *
 * Field names stay in Portuguese where they refer to a concept specific to the
 * Brazilian court system (autuação, polo ativo, movimentação). Translating those
 * would make it harder to trace where each piece of data comes from.
 */

/** A case participant: party, attorney or representative. */
export interface Party {
  name: string;
  /** Procedural role: APELANTE, APELADO, ADVOGADO, etc. */
  role: string;
  /** Identity document. Absent for participants that do not publish one. */
  document?: { kind: 'CPF' | 'CNPJ'; value: string };
  /** Bar registration, when the participant is an attorney. */
  oab?: string;
  status?: string;
}

/** An entry in the case history (movimentação). */
export interface Movement {
  /** ISO 8601 date. */
  date: string;
  description: string;
}

/**
 * A document attached to the case.
 *
 * All four identifiers are required by the download link and none can be derived
 * from the others, so they are all kept.
 */
export interface CaseDocument {
  /** ISO 8601 date. */
  date: string;
  /** Display name: "Despacho", "Acórdão"... */
  name: string;
  /** Type as declared by the system. */
  kind: string;
  idBin: string;
  numeroDocumento: string;
  idProcessoDocumento: string;
  /** Local path of the PDF once downloaded. */
  localPath?: string;
}

/** A legal case with everything the public search exposes. */
export interface LegalCase {
  /** Unique CNJ number. Used as the deduplication key. */
  number: string;
  /**
   * Access token for the detail view. Verified not to expire with the session,
   * so it can be persisted to resume without re-running the search.
   */
  ca: string;

  judicialClass?: string;
  subject?: string;
  /** Filing date (autuação) in ISO 8601. */
  filingDate?: string;
  jurisdiction?: string;
  court?: string;
  address?: string;
  referenceCase?: string;

  activeParties: Party[];
  passiveParties: Party[];
  movements: Movement[];
  documents: CaseDocument[];

  /**
   * Case under segredo de justiça: the system returns partial detail or denies
   * it. Not an error, but a valid domain state.
   */
  sealed: boolean;

  /** Extraction timestamp, ISO 8601. */
  extractedAt: string;
}

/** A row from the results table, before opening the detail view. */
export interface SearchResultRow {
  number: string;
  ca: string;
  judicialClass?: string;
  subject?: string;
  parties?: string;
  lastMovement?: string;
}

/**
 * Search criteria.
 *
 * The sweep generates many of these, progressively narrower, until none of them
 * hits the 30-result cap the site imposes.
 */
export interface Query {
  /** Start of the filing date range, ISO 8601. */
  from: string;
  /** End of the filing date range, ISO 8601. */
  to: string;
  /** Internal judicial class id, for the second partition dimension. */
  judicialClassId?: string;
  /** Class name, which the form requires alongside the id. */
  judicialClassName?: string;
}

/** Outcome of running a query. */
export interface SearchResponse {
  rows: SearchResultRow[];
  /**
   * The query hit the cap and results are being withheld. Callers must split the
   * query rather than treat the coverage as complete.
   */
  capped: boolean;
  /**
   * How that verdict was reached. Kept so callers can report the two readings
   * disagreeing, which is how a change in the server's warning wording would
   * announce itself instead of passing unnoticed.
   */
  capSignal: CapSignal;
  /** Server rejection message, when it validated and discarded the query. */
  rejectionMessage?: string;
}

/** Both readings of the result cap, kept separate on purpose. */
export interface CapSignal {
  capped: boolean;
  byText: boolean;
  byCount: boolean;
  disagree: boolean;
}

/** A judicial class from the catalog, used for partitioning. */
export interface JudicialClass {
  id: string;
  name: string;
}
