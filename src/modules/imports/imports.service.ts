import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  CreateClientLocationRequestSchema,
  CreateClientRequestSchema,
  CreateInsurerRequestSchema,
  IMPORT_CONTACTS_PER_ROW,
  IMPORT_SHEETS,
  INDIAN_STATES,
  PincodeValueSchema,
  TacCodeSchema,
  type ContactFormValues,
  type CreateClientLocationRequest,
  type CreateClientRequest,
  type CreateInsurerRequest,
  type ImportEntity,
  type ImportIssue,
  type ImportQuery,
  type ImportReport,
  type OccupancyRef,
} from '../../shared/index.ts';
import { type Types, mongo } from 'mongoose';
import type { z } from 'zod';
import { withTransaction } from '../../lib/db.ts';
import type { Logger } from '../../lib/logger.ts';
import { sortKey } from '../../lib/text.ts';
import { writeAudits, type AuditEntry } from '../audit/audit.service.ts';
import { ClientLocationModel } from '../clients/client-location.model.ts';
import { ClientModel } from '../clients/client.model.ts';
import {
  toClientAuditView,
  toClientDto,
  toClientLocationAuditView,
  toClientLocationDto,
} from '../clients/clients.mapper.ts';
import {
  newClientFields,
  newLocationFields,
  type Actor,
  type PincodeFacts,
} from '../clients/clients.service.ts';
import { InsurerModel } from '../insurers/insurer.model.ts';
import { toInsurerAuditView, toInsurerDto } from '../insurers/insurers.mapper.ts';
import { newInsurerFields } from '../insurers/insurers.service.ts';
import { getActiveVersion } from '../masters/masters.service.ts';
import { OccupancyModel } from '../masters/occupancy.model.ts';
import { PincodeModel } from '../masters/pincode.model.ts';
import { parseUpload, type SheetRow } from './workbook.ts';

interface Candidate<T> {
  row: number;
  label: string;
  value: T;
}

interface Checked<T> {
  issues: ImportIssue[];
  valid: Candidate<T>[];
}

function header(entity: ImportEntity, key: string): string | null {
  return IMPORT_SHEETS[entity].columns.find((column) => column.key === key)?.header ?? null;
}

function issue(
  row: number,
  entity: ImportEntity,
  key: string | null,
  message: string,
): ImportIssue {
  return { row, column: key ? header(entity, key) : null, message };
}

const CONTACT_FIELDS = ['name', 'designation', 'email', 'phone'] as const;

/** The contacts filled in on a row, and which numbered columns each came from. */
function contactsOf(values: Record<string, string>): {
  contacts: ContactFormValues[];
  slots: number[];
} {
  const contacts: ContactFormValues[] = [];
  const slots: number[] = [];
  for (let slot = 1; slot <= IMPORT_CONTACTS_PER_ROW; slot += 1) {
    const field = (name: string) => values[`contact${slot}${name}`] ?? '';
    const contact = {
      name: field('Name'),
      designation: field('Designation'),
      email: field('Email'),
      phone: field('Phone'),
    };
    if (Object.values(contact).some((value) => value !== '')) {
      contacts.push(contact);
      slots.push(slot);
    }
  }
  return { contacts, slots };
}

/** The column a contact issue belongs to: contacts.1.email is "Contact 2 email" when slot 2. */
function contactKey(path: readonly PropertyKey[], slots: readonly number[]): string | null {
  const [, index, field] = path;
  const slot = typeof index === 'number' ? slots[index] : undefined;
  if (slot === undefined || typeof field !== 'string') return null;
  if (!(CONTACT_FIELDS as readonly string[]).includes(field)) return null;
  return `contact${slot}${field.charAt(0).toUpperCase()}${field.slice(1)}`;
}

function zodIssues(
  entity: ImportEntity,
  row: number,
  error: z.ZodError,
  keyOf: (path: readonly PropertyKey[]) => string | null,
): ImportIssue[] {
  return error.issues.map((zodIssue) => issue(row, entity, keyOf(zodIssue.path), zodIssue.message));
}

/** A state written in any case ("maharashtra") as it is in the list; other text unchanged. */
function canonicalState(value: string): string {
  const wanted = value.toLowerCase();
  return INDIAN_STATES.find((state) => state.toLowerCase() === wanted) ?? value;
}

async function occupanciesByCode(codes: readonly string[]): Promise<Map<string, OccupancyRef>> {
  if (codes.length === 0) return new Map();
  const version = await getActiveVersion('OCCUPANCY');
  const docs = await OccupancyModel.find(
    { versionId: version._id, tacCode: { $in: [...new Set(codes)] } },
    { tacCode: 1, description: 1 },
  ).lean();
  return new Map(
    docs.map((doc) => [doc.tacCode, { tacCode: doc.tacCode, description: doc.description }]),
  );
}

async function pincodesByValue(pincodes: readonly string[]): Promise<Map<string, PincodeFacts>> {
  if (pincodes.length === 0) return new Map();
  const version = await getActiveVersion('PINCODE');
  const docs = await PincodeModel.find(
    { versionId: version._id, pincode: { $in: [...new Set(pincodes)] } },
    { pincode: 1, state: 1, district: 1, eqZone: 1 },
  ).lean();
  return new Map(
    docs.map((doc) => [
      doc.pincode,
      {
        state: doc.state,
        district: doc.district,
        eqZone: doc.eqZone,
        versionId: version._id.toHexString(),
      },
    ]),
  );
}

/**
 * Master problems of rows that already failed their field checks, so each row lists every
 * problem at once: an occupancy code or pincode written correctly but not in the active master.
 */
function masterIssues(
  entity: ImportEntity,
  failed: readonly SheetRow[],
  occupancies: ReadonlyMap<string, OccupancyRef>,
  pincodes?: ReadonlyMap<string, PincodeFacts>,
): ImportIssue[] {
  return failed.flatMap(({ row, values }) => {
    const found: ImportIssue[] = [];
    const code = values.occupancyCode ?? '';
    if (code && TacCodeSchema.safeParse(code).success && !occupancies.has(code.trim())) {
      found.push(
        issue(
          row,
          entity,
          'occupancyCode',
          `Occupancy code ${code.trim()} is not in the active master`,
        ),
      );
    }
    const pincode = (values.pincode ?? '').trim();
    if (pincodes && PincodeValueSchema.safeParse(pincode).success && !pincodes.has(pincode)) {
      found.push(issue(row, entity, 'pincode', `Pincode ${pincode} is not in the active master`));
    }
    return found;
  });
}

/** Codes and pincodes worth looking up on failed rows: written in the right form. */
function lookupValues(failed: readonly SheetRow[], key: 'occupancyCode' | 'pincode'): string[] {
  const schema = key === 'pincode' ? PincodeValueSchema : TacCodeSchema;
  return failed.flatMap(({ values }) => {
    const value = (values[key] ?? '').trim();
    return value && schema.safeParse(value).success ? [value] : [];
  });
}

// Clients

interface ClientRow {
  input: CreateClientRequest;
  occupancy: OccupancyRef;
}

async function checkClients(rows: readonly SheetRow[]): Promise<Checked<ClientRow>> {
  const entity = 'clients';
  const issues: ImportIssue[] = [];
  const parsed: Candidate<CreateClientRequest>[] = [];
  const failed: SheetRow[] = [];
  for (const sheetRow of rows) {
    const { row, values } = sheetRow;
    const { contacts, slots } = contactsOf(values);
    const result = CreateClientRequestSchema.safeParse({
      name: values.name ?? '',
      gstin: values.gstin ?? '',
      address: {
        line1: values.line1 ?? '',
        line2: values.line2 ?? '',
        city: values.city ?? '',
        state: canonicalState(values.state ?? ''),
        pincode: values.pincode ?? '',
      },
      contacts,
      natureOfBusiness: values.natureOfBusiness ?? '',
      occupancyCode: values.occupancyCode ?? '',
    });
    if (!result.success) {
      issues.push(
        ...zodIssues(entity, row, result.error, (path) => {
          if (path[0] === 'contacts') return contactKey(path, slots);
          const key = path[0] === 'address' ? path[1] : path[0];
          return typeof key === 'string' ? key : null;
        }),
      );
      failed.push(sheetRow);
      continue;
    }
    parsed.push({ row, label: result.data.name, value: result.data });
  }

  const occupancies = await occupanciesByCode([
    ...parsed.map((c) => c.value.occupancyCode),
    ...lookupValues(failed, 'occupancyCode'),
  ]);
  issues.push(...masterIssues(entity, failed, occupancies));
  const gstins = parsed.flatMap((c) => (c.value.gstin ? [c.value.gstin] : []));
  const nameKeys = parsed.flatMap((c) => (c.value.gstin ? [] : [sortKey(c.value.name)]));
  const [takenGstins, takenNames] = await Promise.all([
    ClientModel.find({ gstin: { $in: gstins } }, { gstin: 1, name: 1 }).lean(),
    ClientModel.find({ nameKey: { $in: nameKeys }, gstin: null }, { nameKey: 1, name: 1 }).lean(),
  ]);
  const ownerOfGstin = new Map(takenGstins.map((doc) => [doc.gstin, doc.name]));
  const existingNames = new Set(takenNames.map((doc) => doc.nameKey));

  const valid: Candidate<ClientRow>[] = [];
  const firstRowOf = new Map<string, number>();
  for (const candidate of parsed) {
    const { row, value } = candidate;
    const rowIssues: ImportIssue[] = [];
    const occupancy = occupancies.get(value.occupancyCode);
    if (!occupancy) {
      rowIssues.push(
        issue(
          row,
          entity,
          'occupancyCode',
          `Occupancy code ${value.occupancyCode} is not in the active master`,
        ),
      );
    }
    // Clients without a GSTIN are told apart by name, so a file imported twice is caught.
    const identity = value.gstin ? `gstin:${value.gstin}` : `name:${sortKey(value.name)}`;
    const earlier = firstRowOf.get(identity);
    if (earlier !== undefined) {
      rowIssues.push(
        value.gstin
          ? issue(row, entity, 'gstin', `GSTIN ${value.gstin} is also on row ${earlier}`)
          : issue(
              row,
              entity,
              'name',
              `A client without a GSTIN named ${value.name} is also on row ${earlier}`,
            ),
      );
    } else {
      firstRowOf.set(identity, row);
    }
    if (value.gstin && ownerOfGstin.has(value.gstin)) {
      rowIssues.push(
        issue(
          row,
          entity,
          'gstin',
          `GSTIN ${value.gstin} already belongs to ${ownerOfGstin.get(value.gstin)}`,
        ),
      );
    }
    if (!value.gstin && existingNames.has(sortKey(value.name))) {
      rowIssues.push(
        issue(row, entity, 'name', `A client named ${value.name} without a GSTIN already exists`),
      );
    }
    if (rowIssues.length > 0 || !occupancy) issues.push(...rowIssues);
    else valid.push({ ...candidate, value: { input: value, occupancy } });
  }
  return { issues, valid };
}

async function saveClients(rows: readonly Candidate<ClientRow>[], actor: Actor) {
  return withTransaction(async (session) => {
    const docs = await ClientModel.insertMany(
      rows.map(({ value }) => newClientFields(value.input, value.occupancy, actor.id)),
      { session },
    );
    const audits: AuditEntry[] = docs.map((doc) => {
      const client = toClientDto(doc.toObject(), 0);
      return {
        userId: actor.id,
        action: AUDIT_ACTIONS.CLIENT_CREATED,
        entity: AUDIT_ENTITIES.CLIENT,
        entityId: client.id,
        before: null,
        after: toClientAuditView(client),
        requestId: actor.requestId,
      };
    });
    await writeAudits(audits, session);
    return docs.length;
  });
}

// Risk locations

interface LocationRow {
  clientId: Types.ObjectId;
  input: CreateClientLocationRequest;
  pincode: PincodeFacts;
  occupancy: OccupancyRef | null;
}

interface ClientRef {
  _id: Types.ObjectId;
  name: string;
}

async function checkLocations(rows: readonly SheetRow[]): Promise<Checked<LocationRow>> {
  const entity = 'client-locations';
  const issues: ImportIssue[] = [];
  const parsed: Candidate<
    CreateClientLocationRequest & { clientGstin: string; clientName: string }
  >[] = [];
  const failed: SheetRow[] = [];
  for (const sheetRow of rows) {
    const { row, values } = sheetRow;
    const clientGstin = (values.clientGstin ?? '').replace(/\s+/g, '').toUpperCase();
    const clientName = values.clientName ?? '';
    const noClient = !clientGstin && !clientName;
    if (noClient) {
      issues.push(
        issue(
          row,
          entity,
          'clientGstin',
          'Enter the client GSTIN, or the client name for a client without one',
        ),
      );
    }
    const result = CreateClientLocationRequestSchema.safeParse({
      name: values.name ?? '',
      line1: values.line1 ?? '',
      line2: values.line2 ?? '',
      city: values.city ?? '',
      pincode: values.pincode ?? '',
      occupancyCode: values.occupancyCode ?? '',
    });
    if (!result.success) {
      issues.push(
        ...zodIssues(entity, row, result.error, (path) =>
          typeof path[0] === 'string' ? path[0] : null,
        ),
      );
    }
    if (noClient || !result.success) {
      failed.push(sheetRow);
      continue;
    }
    parsed.push({
      row,
      label: result.data.name,
      value: { ...result.data, clientGstin, clientName },
    });
  }

  const gstins = parsed.flatMap((c) => (c.value.clientGstin ? [c.value.clientGstin] : []));
  const nameKeys = parsed.flatMap((c) =>
    c.value.clientGstin ? [] : [sortKey(c.value.clientName)],
  );
  const [byGstinDocs, byNameDocs, pincodes, occupancies] = await Promise.all([
    ClientModel.find({ gstin: { $in: gstins } }, { gstin: 1, name: 1 }).lean(),
    ClientModel.find({ nameKey: { $in: nameKeys } }, { nameKey: 1, name: 1 }).lean(),
    pincodesByValue([...parsed.map((c) => c.value.pincode), ...lookupValues(failed, 'pincode')]),
    occupanciesByCode([
      ...parsed.flatMap((c) => (c.value.occupancyCode ? [c.value.occupancyCode] : [])),
      ...lookupValues(failed, 'occupancyCode'),
    ]),
  ]);
  issues.push(...masterIssues(entity, failed, occupancies, pincodes));
  const clientByGstin = new Map(byGstinDocs.map((doc) => [doc.gstin, doc as ClientRef]));
  const clientsByName = new Map<string, ClientRef[]>();
  for (const doc of byNameDocs) {
    clientsByName.set(doc.nameKey, [...(clientsByName.get(doc.nameKey) ?? []), doc]);
  }

  // Location names already used by these clients, so importing a file twice is caught.
  const clientIds = [...clientByGstin.values(), ...byNameDocs].map((client) => client._id);
  const existing = await ClientLocationModel.find(
    { clientId: { $in: clientIds } },
    { clientId: 1, name: 1 },
  ).lean();
  const usedNames = new Set(
    existing.map((doc) => `${doc.clientId.toHexString()}:${sortKey(doc.name)}`),
  );

  const valid: Candidate<LocationRow>[] = [];
  const firstRowOf = new Map<string, number>();
  for (const { row, value } of parsed) {
    const rowIssues: ImportIssue[] = [];
    let client: ClientRef | undefined;
    if (value.clientGstin) {
      client = clientByGstin.get(value.clientGstin);
      if (!client) {
        rowIssues.push(
          issue(
            row,
            entity,
            'clientGstin',
            `No client has GSTIN ${value.clientGstin}. Import the client first.`,
          ),
        );
      } else if (value.clientName && sortKey(value.clientName) !== sortKey(client.name)) {
        rowIssues.push(
          issue(
            row,
            entity,
            'clientName',
            `GSTIN ${value.clientGstin} belongs to ${client.name}, not ${value.clientName}`,
          ),
        );
      }
    } else {
      const matches = clientsByName.get(sortKey(value.clientName)) ?? [];
      if (matches.length === 0) {
        rowIssues.push(
          issue(
            row,
            entity,
            'clientName',
            `No client is named ${value.clientName}. Import the client first.`,
          ),
        );
      } else if (matches.length > 1) {
        rowIssues.push(
          issue(
            row,
            entity,
            'clientName',
            `${matches.length} clients are named ${value.clientName}. Use the client GSTIN.`,
          ),
        );
      } else {
        client = matches[0];
      }
    }
    const pincode = pincodes.get(value.pincode);
    if (!pincode) {
      rowIssues.push(
        issue(row, entity, 'pincode', `Pincode ${value.pincode} is not in the active master`),
      );
    }
    const occupancy = value.occupancyCode ? (occupancies.get(value.occupancyCode) ?? null) : null;
    if (value.occupancyCode && !occupancy) {
      rowIssues.push(
        issue(
          row,
          entity,
          'occupancyCode',
          `Occupancy code ${value.occupancyCode} is not in the active master`,
        ),
      );
    }
    if (client) {
      const identity = `${client._id.toHexString()}:${sortKey(value.name)}`;
      const earlier = firstRowOf.get(identity);
      if (earlier !== undefined) {
        rowIssues.push(
          issue(
            row,
            entity,
            'name',
            `${client.name} also has a location named ${value.name} on row ${earlier}`,
          ),
        );
      } else {
        firstRowOf.set(identity, row);
      }
      if (usedNames.has(identity)) {
        rowIssues.push(
          issue(row, entity, 'name', `${client.name} already has a location named ${value.name}`),
        );
      }
    }
    if (rowIssues.length > 0 || !client || !pincode) {
      issues.push(...rowIssues);
      continue;
    }
    const { clientGstin: _gstin, clientName: _name, ...input } = value;
    valid.push({
      row,
      label: `${client.name} · ${value.name}`,
      value: { clientId: client._id, input, pincode, occupancy },
    });
  }
  return { issues, valid };
}

async function saveLocations(rows: readonly Candidate<LocationRow>[], actor: Actor) {
  return withTransaction(async (session) => {
    const docs = await ClientLocationModel.insertMany(
      rows.map(({ value }) =>
        newLocationFields(value.clientId, value.input, value.pincode, value.occupancy, actor.id),
      ),
      { session },
    );
    const audits: AuditEntry[] = docs.map((doc) => {
      const location = toClientLocationDto(doc.toObject());
      return {
        userId: actor.id,
        action: AUDIT_ACTIONS.CLIENT_LOCATION_CREATED,
        entity: AUDIT_ENTITIES.CLIENT_LOCATION,
        entityId: location.id,
        before: null,
        after: toClientLocationAuditView(location),
        requestId: actor.requestId,
      };
    });
    await writeAudits(audits, session);
    return docs.length;
  });
}

// Insurers

async function checkInsurers(rows: readonly SheetRow[]): Promise<Checked<CreateInsurerRequest>> {
  const entity = 'insurers';
  const issues: ImportIssue[] = [];
  const parsed: Candidate<CreateInsurerRequest>[] = [];
  for (const { row, values } of rows) {
    const { contacts, slots } = contactsOf(values);
    const rfqEmails = (values.rfqEmails ?? '').split(/[\s,;]+/).filter(Boolean);
    const result = CreateInsurerRequestSchema.safeParse({
      company: values.company ?? '',
      branch: values.branch ?? '',
      contacts,
      rfqEmails,
    });
    if (!result.success) {
      for (const zodIssue of result.error.issues) {
        const [field, index] = zodIssue.path;
        if (field === 'rfqEmails') {
          const email = typeof index === 'number' ? rfqEmails[index] : undefined;
          issues.push(
            issue(
              row,
              entity,
              'rfqEmails',
              email ? `${email}: ${zodIssue.message}` : zodIssue.message,
            ),
          );
        } else {
          const key =
            field === 'contacts'
              ? contactKey(zodIssue.path, slots)
              : typeof field === 'string'
                ? field
                : null;
          issues.push(issue(row, entity, key, zodIssue.message));
        }
      }
      continue;
    }
    parsed.push({
      row,
      label: `${result.data.company}, ${result.data.branch}`,
      value: result.data,
    });
  }

  const existing = await InsurerModel.find(
    { companyKey: { $in: parsed.map((c) => sortKey(c.value.company)) } },
    { companyKey: 1, branchKey: 1 },
  ).lean();
  const taken = new Set(existing.map((doc) => `${doc.companyKey}|${doc.branchKey}`));
  const valid: Candidate<CreateInsurerRequest>[] = [];
  const firstRowOf = new Map<string, number>();
  for (const candidate of parsed) {
    const { row, value, label } = candidate;
    const identity = `${sortKey(value.company)}|${sortKey(value.branch)}`;
    const earlier = firstRowOf.get(identity);
    if (earlier !== undefined) {
      issues.push(issue(row, entity, 'branch', `${label} is also on row ${earlier}`));
      continue;
    }
    firstRowOf.set(identity, row);
    if (taken.has(identity)) {
      issues.push(issue(row, entity, 'branch', `${label} is already in the master`));
      continue;
    }
    valid.push(candidate);
  }
  return { issues, valid };
}

async function saveInsurers(rows: readonly Candidate<CreateInsurerRequest>[], actor: Actor) {
  return withTransaction(async (session) => {
    const docs = await InsurerModel.insertMany(
      rows.map(({ value }) => newInsurerFields(value, actor.id)),
      { session },
    );
    const audits: AuditEntry[] = docs.map((doc) => {
      const insurer = toInsurerDto(doc.toObject());
      return {
        userId: actor.id,
        action: AUDIT_ACTIONS.INSURER_CREATED,
        entity: AUDIT_ENTITIES.INSURER,
        entityId: insurer.id,
        before: null,
        after: toInsurerAuditView(insurer),
        requestId: actor.requestId,
      };
    });
    await writeAudits(audits, session);
    return docs.length;
  });
}

function buildReport(
  entity: ImportEntity,
  dryRun: boolean,
  sheetRows: readonly SheetRow[],
  checked: Checked<unknown>,
  createdCount: number,
  fileErrors: ImportIssue[] = [],
): ImportReport {
  const rowNumbers = new Set(sheetRows.map(({ row }) => row));
  const issuesByRow = new Map<number, ImportIssue[]>();
  const otherIssues: ImportIssue[] = [];
  for (const rowIssue of checked.issues) {
    if (rowIssue.row !== null && rowNumbers.has(rowIssue.row)) {
      issuesByRow.set(rowIssue.row, [...(issuesByRow.get(rowIssue.row) ?? []), rowIssue]);
    } else {
      otherIssues.push(rowIssue);
    }
  }
  const labels = new Map(checked.valid.map(({ row, label }) => [row, label]));
  const rows = sheetRows.map(({ row, values }) => {
    const label = labels.get(row) ?? null;
    return {
      row,
      valid: label !== null,
      label,
      values,
      issues: (issuesByRow.get(row) ?? []).map(({ column, message }) => ({ column, message })),
    };
  });
  return {
    entity,
    dryRun,
    rowsRead: sheetRows.length,
    validRows: checked.valid.length,
    invalidRows: rows.length - checked.valid.length,
    imported: createdCount > 0,
    createdCount,
    fileErrors: [...otherIssues, ...fileErrors],
    rows,
  };
}

function fileError(message: string): ImportIssue {
  return { row: null, column: null, message };
}

/** "Row 4", "Rows 4 and 9", "Rows 4, 9 and 12". */
function rowList(rows: readonly number[]): string {
  if (rows.length === 1) return `Row ${rows[0]}`;
  return `Rows ${rows.slice(0, -1).join(', ')} and ${rows.at(-1)}`;
}

async function checkAndSave<T>(
  entity: ImportEntity,
  sheetRows: readonly SheetRow[],
  query: ImportQuery,
  actor: Actor,
  check: (rows: readonly SheetRow[]) => Promise<Checked<T>>,
  save: (rows: readonly Candidate<T>[], actor: Actor) => Promise<number>,
): Promise<ImportReport> {
  const checked = await check(sheetRows);
  if (query.dryRun) return buildReport(entity, true, sheetRows, checked, 0);

  // Rows with problems are left out. A chosen row that is not valid stops the import, so what
  // is saved is exactly what the preview showed.
  const validRows = new Set(checked.valid.map(({ row }) => row));
  const chosen = query.rows ?? [...validRows];
  const notValid = chosen.filter((row) => !validRows.has(row)).sort((a, b) => a - b);
  if (notValid.length > 0) {
    const problem = fileError(
      `${rowList(notValid)} cannot be imported: ${notValid.length === 1 ? 'it has' : 'they have'} problems or ${notValid.length === 1 ? 'is' : 'are'} not in the file. Leave ${notValid.length === 1 ? 'it' : 'them'} out and import again.`,
    );
    return buildReport(entity, false, sheetRows, checked, 0, [problem]);
  }
  if (chosen.length === 0) {
    return buildReport(entity, false, sheetRows, checked, 0, [
      fileError('No row can be imported. Fix the rows with problems and preview again.'),
    ]);
  }
  const selected = new Set(chosen);
  try {
    const created = await save(
      checked.valid.filter(({ row }) => selected.has(row)),
      actor,
    );
    return buildReport(entity, false, sheetRows, checked, created);
  } catch (error) {
    // Someone saved a clashing record between the check and the save; the unique index refused it.
    if (error instanceof mongo.MongoServerError && error.code === 11000) {
      return buildReport(entity, false, sheetRows, checked, 0, [
        fileError(
          'A record in this file was saved by someone else while importing. Nothing was imported; preview the file again.',
        ),
      ]);
    }
    throw error;
  }
}

/**
 * Checks an uploaded workbook and reports every row. Unless it is a dry run, the chosen valid
 * rows (all valid rows when none are chosen) are saved in one transaction, each with its own
 * audit entry; rows with problems are left out.
 */
export async function runImport(
  entity: ImportEntity,
  data: Buffer,
  query: ImportQuery,
  actor: Actor,
  log?: Pick<Logger, 'warn'>,
): Promise<ImportReport> {
  const parsed = await parseUpload(entity, data);
  if (!parsed.ok) {
    if (parsed.cause) log?.warn({ err: parsed.cause, entity }, 'Import workbook could not be read');
    return buildReport(entity, query.dryRun, [], { issues: [], valid: [] }, 0, parsed.issues);
  }
  const { rows } = parsed;
  switch (entity) {
    case 'clients':
      return checkAndSave(entity, rows, query, actor, checkClients, saveClients);
    case 'client-locations':
      return checkAndSave(entity, rows, query, actor, checkLocations, saveLocations);
    case 'insurers':
      return checkAndSave(entity, rows, query, actor, checkInsurers, saveInsurers);
  }
}
