import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { withBrokerLetterhead } from '../src/modules/documents/broker-letterhead.ts';
import { DocumentTemplateModel } from '../src/modules/documents/document-template.model.ts';
import { useTestDatabase } from './helpers/app.ts';

// Every PDF takes the broker's header from the Placement Slip template when its own template
// (or the built-in layout) has none.

useTestDatabase();

const ADDRESS = 'Fiducial Insurance Brokers India Pvt Ltd, 4 Park Street, Pune 411001';

async function storeSlipTemplate() {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Slip').getCell('A1').value = ADDRESS;
  const data = Buffer.from(await workbook.xlsx.writeBuffer());
  await DocumentTemplateModel.create({
    kind: 'PLACEMENT_SLIP',
    fileName: 'slip.xlsx',
    data,
    size: data.length,
    sha256: 'x'.repeat(64),
    check: {
      ok: true,
      problems: [],
      sheets: ['Slip'],
      letterhead: { logo: false, address: ADDRESS },
    },
    uploadedBy: new Types.ObjectId(),
  });
}

describe('withBrokerLetterhead', () => {
  it('leaves a document without a header empty while no Placement Slip template is uploaded', async () => {
    expect(await withBrokerLetterhead({ logo: null, address: null })).toEqual({
      logo: null,
      address: null,
    });
  });

  it('fills a missing address from the Placement Slip template and keeps the document’s own', async () => {
    await storeSlipTemplate();
    expect(await withBrokerLetterhead({ logo: null, address: null })).toEqual({
      logo: null,
      address: ADDRESS,
    });
    expect(await withBrokerLetterhead({ logo: null, address: 'Its own address' })).toEqual({
      logo: null,
      address: 'Its own address',
    });
  });
});
