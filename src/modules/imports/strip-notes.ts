import JSZip from 'jszip';

const NOTE_RELATIONSHIP =
  /<Relationship\b[^>]*\bType="[^"]*\/relationships\/(?:comments|vmlDrawing)"[^>]*\/>/g;

/**
 * The workbook without its cell notes. The import reads only cell values, and exceljs cannot
 * load notes saved by some other tools (openpyxl, for one, keeps them in xl/comments/ under an
 * absolute path, which exceljs fails to resolve). Each worksheet's links to its notes and their
 * drawings are removed; the cells are untouched. A file that is not a zip archive is returned
 * as it is.
 */
export async function withoutNotes(data: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    // Not a zip archive: leave it for the workbook reader to report.
    return data;
  }
  const relsFiles = zip.file(/^xl\/worksheets\/_rels\/[^/]+\.rels$/);
  let changed = false;
  for (const file of relsFiles) {
    const xml = await file.async('string');
    const stripped = xml.replace(NOTE_RELATIONSHIP, '');
    if (stripped !== xml) {
      zip.file(file.name, stripped);
      changed = true;
    }
  }
  if (!changed) return data;
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
