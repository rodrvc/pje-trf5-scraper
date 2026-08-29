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
 * The identifiers a document's download link carries.
 *
 * All five are required to build the GET (ISSUE-6) and none can be derived
 * from the others, so they travel together as one object rather than five
 * loose fields on `CaseDocument`.
 */
export interface DocumentDownloadRef {
  idBin: string;
  numeroDocumento: string;
  /**
   * File name the download link declares (e.g. "Inteiro Teor"). Used to build
   * a descriptive local file name; `idProcessoDocumento` is what guarantees
   * uniqueness, since this name is not guaranteed to be.
   */
  nomeArqProcDocBin: string;
  idProcessoDocumento: string;
  /**
   * The JSF `actionMethod` the download link carries (URL-encoded EL
   * expression naming the backing bean action). ISSUE-6 needs it verbatim to
   * reproduce the GET.
   */
  actionMethod: string;
}

/** A document attached to the case. */
export interface CaseDocument {
  /** ISO 8601 date. */
  date: string;
  /** Display name: "Despacho", "Acórdão"... */
  name: string;
  /** Type as declared by the system. */
  kind: string;
  /** Everything ISSUE-6 needs to build the download GET, as one object. */
  download: DocumentDownloadRef;
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
  /**
   * ISO 8601 date. Read from the header's "Data da Distribuição" (distribution
   * date) field - the brief and PROBLEMS.md call this "autuação" (filing), but
   * that is not the label the detail page itself uses. Kept as `filingDate`
   * since that is the concept the rest of the scraper (the date-window sweep)
   * queries by, but the actual source field is distribuição, not autuação.
   */
  filingDate?: string;
  jurisdiction?: string;
  /** Órgão Julgador Colegiado (the collegiate body), when the case has one. */
  court?: string;
  /** Órgão Julgador (the judging body/chamber), when distinct from `court`. */
  judgingBody?: string;
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
  /**
   * Party name filter, for the third dimension (ISSUE-4b).
   *
   * Not an exact-name lookup: the server runs `LIKE %token% AND LIKE %token%`
   * against whitespace-separated tokens (PROBLEMS.md §5, "The third
   * dimension"). The server requires at least two tokens; a single token (or
   * an empty string) is rejected with `RejectedQueryError`.
   */
  partyName?: string;
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

